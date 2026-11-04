"""Validation, cleaning and feature engineering shared by training and inference."""
import numpy as np
import pandas as pd

REQUIRED_COLUMNS = ["transaction_id", "user_id", "amount", "transaction_type", "timestamp",
                    "location", "merchant_category", "account_age_days", "transaction_frequency"]
CATEGORICAL = ["transaction_type", "location", "merchant_category"]   # raw input columns
ONEHOT = ["transaction_type"]                                          # low-cardinality: one-hot
# location / merchant_category are rarity-encoded (-log of how common the value is, globally
# and in the user's own history). High-cardinality one-hot columns dilute Isolation Forest splits.
NUMERIC = ["log_amount", "account_age_days", "transaction_frequency", "hour", "is_night",
           "is_weekend", "user_amount_ratio", "burst_1h",
           "category_rarity", "location_rarity", "user_category_rarity", "user_location_rarity"]
MIN_USER_HISTORY = 10
RARITY_FLOOR = 1e-3


class ValidationError(ValueError):
    pass


def validate_columns(df: pd.DataFrame):
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValidationError(f"Missing required columns: {', '.join(missing)}")


def clean(df: pd.DataFrame, profile: dict | None = None):
    """Handle missing / malformed values. Returns (clean_df, report)."""
    validate_columns(df)
    df = df[REQUIRED_COLUMNS].copy()
    report = {"rows": len(df), "imputed": {}}

    for c in ["amount", "account_age_days", "transaction_frequency"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
        n = int(df[c].isna().sum())
        if n:
            fallback = (profile or {}).get("medians", {}).get(c)
            df[c] = df[c].fillna(fallback if fallback is not None else df[c].median())
            if df[c].isna().any():
                df[c] = df[c].fillna(0)
            report["imputed"][c] = n
    df["amount"] = df["amount"].clip(lower=0)

    df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    n = int(df["timestamp"].isna().sum())
    if n:
        df["timestamp"] = df["timestamp"].fillna(df["timestamp"].median())
        if df["timestamp"].isna().any():
            df["timestamp"] = df["timestamp"].fillna(pd.Timestamp.now().floor("s"))
        report["imputed"]["timestamp"] = n

    for c in CATEGORICAL + ["user_id"]:
        df[c] = df[c].astype("string").str.strip()
        n = int((df[c].isna() | (df[c] == "")).sum())
        df[c] = df[c].fillna("UNKNOWN").replace("", "UNKNOWN").astype(str)
        if n:
            report["imputed"][c] = n
    df["transaction_id"] = df["transaction_id"].astype(str)
    return df.reset_index(drop=True), report


def _burst_counts(df: pd.DataFrame) -> np.ndarray:
    """Other transactions by the same user within +/-1 hour (inside the supplied data)."""
    out = np.zeros(len(df), dtype=int)
    ts = ((df["timestamp"] - pd.Timestamp("1970-01-01")) / pd.Timedelta(seconds=1)).to_numpy()
    for _, idx in df.groupby("user_id").indices.items():
        if len(idx) < 2:
            continue
        t = ts[idx]
        s = np.sort(t)
        out[idx] = (np.searchsorted(s, t + 3600, side="right") -
                    np.searchsorted(s, t - 3600, side="left") - 1)
    return out


def build_profile(df: pd.DataFrame) -> dict:
    """Reference statistics learned from training data (used for features + explanations)."""
    g = df.groupby("user_id")
    user_cnt = g.size()
    prof = {
        "medians": {"amount": float(df["amount"].median()),
                    "account_age_days": float(df["account_age_days"].median()),
                    "transaction_frequency": float(df["transaction_frequency"].median())},
        "user_median_amount": g["amount"].median().to_dict(),
        "user_count": user_cnt.to_dict(),
        "user_cat_share": {u: x.value_counts(normalize=True).to_dict()
                           for u, x in df.groupby("user_id")["merchant_category"]},
        "user_loc_share": {u: x.value_counts(normalize=True).to_dict()
                           for u, x in df.groupby("user_id")["location"]},
        "category_share": df["merchant_category"].value_counts(normalize=True).to_dict(),
        "location_share": df["location"].value_counts(normalize=True).to_dict(),
        "q": {"amount_p90": float(df["amount"].quantile(.90)),
              "amount_p99": float(df["amount"].quantile(.99)),
              "freq_p99": float(df["transaction_frequency"].quantile(.99)),
              "freq_median": float(df["transaction_frequency"].median()),
              "age_p10": float(df["account_age_days"].quantile(.10))},
        "categories": {c: sorted(df[c].unique().tolist()) for c in CATEGORICAL},
    }
    return prof


def user_medians(df: pd.DataFrame, profile: dict) -> pd.Series:
    """Typical amount per user: batch median if >=3 rows, else training history, else global."""
    batch = df.groupby("user_id")["amount"].agg(["median", "size"])
    batch_ok = batch[batch["size"] >= 3]["median"].to_dict()
    hist = profile["user_median_amount"]
    glob = profile["medians"]["amount"]
    return df["user_id"].map(lambda u: batch_ok.get(u, hist.get(u, glob)))


def build_features(df: pd.DataFrame, profile: dict) -> pd.DataFrame:
    X = df.copy()
    X["log_amount"] = np.log1p(X["amount"])
    X["hour"] = X["timestamp"].dt.hour
    X["is_night"] = X["hour"].between(0, 5).astype(int)
    X["is_weekend"] = (X["timestamp"].dt.dayofweek >= 5).astype(int)
    X["typical_amount"] = user_medians(X, profile).astype(float)
    X["user_amount_ratio"] = np.log1p(X["amount"] / X["typical_amount"].clip(lower=1))
    X["burst_1h"] = _burst_counts(X)

    def rarity(share):
        return -np.log(np.maximum(share, RARITY_FLOOR))

    X["category_rarity"] = rarity(X["merchant_category"].map(profile["category_share"]).fillna(0.0))
    X["location_rarity"] = rarity(X["location"].map(profile["location_share"]).fillna(0.0))

    uc, ul = [], []
    for u, c, l in zip(X["user_id"], X["merchant_category"], X["location"]):
        if profile["user_count"].get(u, 0) >= MIN_USER_HISTORY:
            uc.append(profile["user_cat_share"].get(u, {}).get(c, 0.0))
            ul.append(profile["user_loc_share"].get(u, {}).get(l, 0.0))
        else:  # unknown / thin history -> fall back to global rarity so it is not penalised twice
            uc.append(profile["category_share"].get(c, 0.0))
            ul.append(profile["location_share"].get(l, 0.0))
    X["user_category_rarity"] = rarity(np.array(uc))
    X["user_location_rarity"] = rarity(np.array(ul))
    return X
