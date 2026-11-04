"""Inference + rule-grounded explanations for the model selected at training time.

Labeled training data selects a supervised classifier; unlabeled data selects
Isolation Forest. Neither path establishes verified real-world fraud risk.

Reasons: the model itself is a black box over many features, so each reason below is
only emitted when a concrete, checkable statistic on the transaction (compared with
training-data / user-history reference values) supports it. If a transaction is
flagged but no single statistic crosses its threshold, we say so rather than invent one.
"""
import json, os
import joblib
import numpy as np
import pandas as pd

from preprocessing.features import build_features, clean

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(HERE, "models", "selected_model.joblib")
CONFIG_PATH = os.path.join(HERE, "models", "config.json")

ACTIONS = {
    "HIGH": "Escalate to a fraud analyst: verify with the account holder and consider a temporary hold.",
    "MEDIUM": "Queue for manual review and compare against the customer's recent activity.",
    "LOW": "No action required.",
}
SUPERVISED_DISCLAIMER = ("This supervised model was trained on supplied labels. Score quality depends on those labels "
                         "and their match to this dataset; scores are not validated real-world fraud probabilities.")
UNSUPERVISED_DISCLAIMER = ("This unsupervised Isolation Forest ranks unusual patterns because no labels were supplied. "
                           "Scores are not fraud probabilities; review flagged transactions.")


def inr(x):
    return f"{x:,.0f}"


class Predictor:
    def __init__(self):
        if not os.path.exists(MODEL_PATH):
            raise FileNotFoundError("Model not found. Run `python train.py` first.")
        self.bundle = joblib.load(MODEL_PATH)
        self.pipe = self.bundle["pipeline"]
        self.profile = self.bundle["profile"]
        self.ref = self.bundle["score_ref"]
        model_type = self.bundle.get("metadata", {}).get("model_type")
        self.disclaimer = (SUPERVISED_DISCLAIMER if model_type == "supervised_classifier"
                           else UNSUPERVISED_DISCLAIMER)
        self.config = self.load_config()

    @staticmethod
    def load_config():
        try:
            return json.load(open(CONFIG_PATH))
        except Exception:
            return {"medium_threshold": 45, "high_threshold": 65}

    def info(self):
        return {**self.bundle["metadata"], "thresholds": self.config,
                "score_reference": self.ref, "disclaimer": self.disclaimer}

    # ---------------------------------------------------------------- scoring
    def _score(self, X):
        if self.bundle.get("metadata", {}).get("model_type") == "supervised_classifier":
            probability = self.pipe.predict_proba(X)[:, 1]
            return probability, probability * 100
        raw = -self.pipe.score_samples(X)
        span = max(self.ref["high"] - self.ref["low"], 1e-9)
        return raw, np.clip((raw - self.ref["low"]) / span, 0, 1) * 100

    @staticmethod
    def _level(score, med, high):
        return "HIGH" if score >= high else "MEDIUM" if score >= med else "LOW"

    # ----------------------------------------------------------- explanations
    def explain(self, r):
        p, q = self.profile, self.profile["q"]
        reasons, feats = [], []

        typical = float(r["typical_amount"])
        ratio = r["amount"] / max(typical, 1)
        if r["amount"] >= q["amount_p99"] or ratio >= 5:
            reasons.append("Unusually high transaction amount")
            feats.append({"feature": "amount", "value": round(float(r["amount"]), 2),
                          "typical": round(typical, 2),
                          "detail": f"{ratio:.1f}x this user's typical amount ({inr(typical)}); "
                                    f"99th percentile of training data is {inr(q['amount_p99'])}"})
        if r["burst_1h"] >= 3:
            reasons.append("Multiple transactions within a short period")
            feats.append({"feature": "burst_1h", "value": int(r["burst_1h"]), "typical": 0,
                          "detail": f"{int(r['burst_1h'])} other transactions by this user within +/-1 hour in the uploaded data"})
        if r["transaction_frequency"] >= q["freq_p99"]:
            reasons.append("Unusual transaction frequency")
            feats.append({"feature": "transaction_frequency", "value": float(r["transaction_frequency"]),
                          "typical": q["freq_median"],
                          "detail": f"frequency {r['transaction_frequency']:.0f} vs training median {q['freq_median']:.0f} (99th pct {q['freq_p99']:.0f})"})
        if r["account_age_days"] <= 30 and r["amount"] >= q["amount_p90"]:
            reasons.append("New account with high-value transaction")
            feats.append({"feature": "account_age_days", "value": float(r["account_age_days"]),
                          "typical": p["medians"]["account_age_days"],
                          "detail": f"account is {r['account_age_days']:.0f} days old; amount is above the training 90th percentile ({inr(q['amount_p90'])})"})

        cat, uid = r["merchant_category"], r["user_id"]
        cat_share = p["category_share"].get(cat, 0.0)
        user_hist = p["user_count"].get(uid, 0)
        user_cat = p["user_cat_share"].get(uid, {}).get(cat, 0.0)
        if cat_share < 0.03:
            reasons.append("Unusual merchant category")
            feats.append({"feature": "merchant_category", "value": cat, "typical": None,
                          "detail": f"'{cat}' makes up only {cat_share * 100:.1f}% of training transactions"})
        elif user_hist >= 10 and user_cat < 0.05:
            reasons.append("Transaction outside the user's normal pattern")
            feats.append({"feature": "merchant_category", "value": cat, "typical": None,
                          "detail": f"user has used '{cat}' in only {user_cat * 100:.1f}% of {user_hist} past transactions"})

        loc, loc_share = r["location"], p["location_share"].get(r["location"], 0.0)
        user_loc = p["user_loc_share"].get(uid, {}).get(loc, 0.0)
        if loc_share < 0.03 or (user_hist >= 10 and user_loc < 0.05):
            reasons.append("Transaction outside the user's normal pattern")
            feats.append({"feature": "location", "value": loc, "typical": None,
                          "detail": (f"'{loc}' is rare overall ({loc_share * 100:.1f}% of training data)"
                                     if loc_share < 0.03 else
                                     f"user transacted in '{loc}' in only {user_loc * 100:.1f}% of past transactions")})
        if r["is_night"] and r["amount"] >= q["amount_p90"]:
            reasons.append("High-value transaction at an unusual hour")
            feats.append({"feature": "hour", "value": int(r["hour"]), "typical": None,
                          "detail": f"{int(r['hour']):02d}:00 (00-05h) with amount above the 90th percentile"})

        reasons = list(dict.fromkeys(reasons))
        return reasons, feats

    # ------------------------------------------------------------- prediction
    def predict_df(self, raw_df, thresholds=None):
        df, report = clean(raw_df, self.profile)
        X = build_features(df, self.profile)
        raw, score = self._score(X)
        cfg = {**self.config, **(thresholds or {})}
        med, high = float(cfg["medium_threshold"]), float(cfg["high_threshold"])
        if not (0 <= med < high <= 100):
            raise ValueError("Thresholds must satisfy 0 <= medium < high <= 100")

        out = []
        for i, r in X.iterrows():
            s = float(score[i])
            level = self._level(s, med, high)
            suspicious = level != "LOW"
            reasons, feats = self.explain(r) if suspicious else ([], [])
            if suspicious and not reasons:
                reasons = ["Unusual combination of features (no single feature exceeded its reference threshold)"]
            out.append({
                "transaction_id": r["transaction_id"],
                "risk_score": int(round(s)),
                "risk_level": level,
                "is_suspicious": bool(suspicious),
                "reasons": reasons,
                "anomalous_features": feats,
                "recommended_action": ACTIONS[level],
                "anomaly_score": round(float(raw[i]), 5),
            })
        return out, report
