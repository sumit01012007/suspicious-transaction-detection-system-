"""Synthetic transaction generator for FraudShield AI.

Normal behaviour is simulated per user (home city, favourite categories, typical
amounts). A small share of rows is replaced by injected anomalies. Labels are
stored separately as ground truth for supervised experiments; unlabeled training
data can instead be used to train Isolation Forest.

Usage:
    python dataset/generate_dataset.py                 # 1,200-row demo file + 6,000-row training file
    python dataset/generate_dataset.py --rows 2000 --out my.csv
"""
import argparse
import os
import numpy as np
import pandas as pd

TYPES = ["PURCHASE", "TRANSFER", "WITHDRAWAL", "PAYMENT", "DEPOSIT"]
LOCATIONS = ["Delhi", "Mumbai", "Bengaluru", "Chennai", "Kolkata", "Hyderabad",
             "Pune", "Jaipur", "Ahmedabad", "Lagos", "Dubai", "Singapore"]
HOME_LOCATIONS = LOCATIONS[:9]
CATEGORIES = ["Groceries", "Restaurants", "Fuel", "Utilities", "Travel", "Shopping",
              "Entertainment", "Healthcare", "Education", "Electronics",
              "Jewellery", "Crypto Exchange", "Gambling"]
COMMON_CATS = CATEGORIES[:10]
RARE_CATS = CATEGORIES[10:]
HERE = os.path.dirname(os.path.abspath(__file__))


def generate(n_rows=1200, n_users=150, anomaly_rate=0.06, seed=42, days=90,
             start="2026-07-01"):
    rng = np.random.default_rng(seed)
    urng = np.random.default_rng(1234)   # fixed: same user population across datasets
    start_ts = pd.Timestamp(start)

    users = []
    for i in range(n_users):
        rng_u, rng_saved = urng, rng
        rng = rng_u
        users.append({
            "user_id": f"USR{i + 1:04d}",
            "home": rng.choice(HOME_LOCATIONS),
            "cats": rng.choice(COMMON_CATS, size=rng.integers(3, 6), replace=False),
            "median_amount": float(rng.lognormal(mean=7.0, sigma=0.5)),  # ~1,100 INR
            "age": int(rng.integers(60, 3000)),
            "freq": int(rng.integers(3, 20)),
        })
        rng = rng_saved

    rows, labels = [], []
    n_anom = int(n_rows * anomaly_rate)
    anom_idx = set(rng.choice(n_rows, size=n_anom, replace=False).tolist())

    for i in range(n_rows):
        u = users[rng.integers(0, n_users)]
        day = int(rng.integers(0, days))
        hour = int(np.clip(rng.normal(14, 4), 6, 23))
        ts = start_ts + pd.Timedelta(days=day, hours=hour,
                                     minutes=int(rng.integers(0, 60)),
                                     seconds=int(rng.integers(0, 60)))
        amount = float(rng.lognormal(np.log(u["median_amount"]), 0.55))
        row = {
            "transaction_id": f"TXN{i + 1:06d}",
            "user_id": u["user_id"],
            "amount": amount,
            "transaction_type": rng.choice(TYPES, p=[.45, .15, .1, .25, .05]),
            "timestamp": ts,
            "location": u["home"] if rng.random() < 0.93 else rng.choice(HOME_LOCATIONS),
            "merchant_category": rng.choice(u["cats"]),
            "account_age_days": u["age"] + day,
            "transaction_frequency": int(np.clip(rng.normal(u["freq"], 2), 1, 40)),
        }
        label = ""
        if i in anom_idx:
            kind = rng.choice(["high_amount", "new_account", "burst", "geo_rare_cat",
                               "night_high", "freq_spike"])
            label = kind
            if kind == "high_amount":
                row["amount"] = float(u["median_amount"] * rng.uniform(15, 60))
            elif kind == "new_account":
                row["account_age_days"] = int(rng.integers(1, 20))
                row["amount"] = float(rng.uniform(40000, 150000))
                row["transaction_type"] = "TRANSFER"
            elif kind == "burst":
                row["transaction_frequency"] = int(rng.integers(35, 70))
                row["amount"] = float(u["median_amount"] * rng.uniform(2, 5))
            elif kind == "geo_rare_cat":
                row["location"] = rng.choice(["Lagos", "Dubai", "Singapore"])
                row["merchant_category"] = rng.choice(RARE_CATS)
                row["amount"] = float(u["median_amount"] * rng.uniform(4, 12))
            elif kind == "night_high":
                row["timestamp"] = ts.normalize() + pd.Timedelta(hours=int(rng.integers(1, 5)),
                                                                  minutes=int(rng.integers(0, 60)))
                row["amount"] = float(u["median_amount"] * rng.uniform(8, 25))
                row["transaction_type"] = "WITHDRAWAL"
            elif kind == "freq_spike":
                row["transaction_frequency"] = int(rng.integers(45, 90))
        rows.append(row)
        labels.append(label)

    df = pd.DataFrame(rows)
    # inject short bursts (same user, minutes apart) for the "burst" anomalies
    for idx in [i for i, l in enumerate(labels) if l == "burst"]:
        uid, base = df.at[idx, "user_id"], df.at[idx, "timestamp"]
        for k in range(3):
            j = int(rng.integers(0, n_rows))
            if labels[j] == "":
                df.at[j, "user_id"] = uid
                df.at[j, "timestamp"] = base + pd.Timedelta(minutes=int(rng.integers(1, 40)))
                df.at[j, "amount"] = float(df.at[idx, "amount"] * rng.uniform(.8, 1.2))
                labels[j] = "burst"

    df["amount"] = df["amount"].round(2)
    df["injected_anomaly"] = labels          # kept ONLY for evaluation
    df = df.sort_values("timestamp").reset_index(drop=True)
    df["transaction_id"] = [f"TXN{i + 1:06d}" for i in range(len(df))]
    return df


def build(n_rows, seed, truth_path=None, **kw):
    """Return the model-facing frame; optionally save injected labels separately."""
    df = generate(n_rows=n_rows, seed=seed, **kw)
    if truth_path:
        df[["transaction_id", "injected_anomaly"]].to_csv(truth_path, index=False)
    return df.drop(columns=["injected_anomaly"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=1200)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default=None)
    ap.add_argument("--train", action="store_true", help="only write training set")
    a = ap.parse_args()

    if a.out:
        build(a.rows, a.seed).to_csv(a.out, index=False)
        print(f"wrote {a.out}")
        return
    if not a.train:
        demo = build(1200, 42, truth_path=os.path.join(HERE, "sample_ground_truth.csv"))
        demo.to_csv(os.path.join(HERE, "sample_transactions.csv"), index=False)
        print(f"wrote sample_transactions.csv ({len(demo)} rows)")
    train = build(6000, 7, n_users=300)
    train.to_csv(os.path.join(HERE, "training_data.csv"), index=False)
    print(f"wrote training_data.csv ({len(train)} rows)")


if __name__ == "__main__":
    main()
