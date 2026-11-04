"""Train a model suited to the supplied transaction dataset.

Labeled data: compare supervised classifiers on a stratified holdout and train
the highest-F1 model on all rows. Unlabeled data: train Isolation Forest.

Usage: python train.py [--data dataset/training_data.csv] [--labels labels.csv]
"""
import argparse
import json
import os

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.metrics import f1_score
from sklearn.model_selection import train_test_split
from sklearn.neighbors import KNeighborsClassifier
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.svm import SVC
from sklearn.tree import DecisionTreeClassifier

from preprocessing.features import NUMERIC, ONEHOT, build_features, build_profile, clean

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(HERE, "models", "selected_model.joblib")
CONFIG_PATH = os.path.join(HERE, "models", "config.json")
DEFAULT_CONFIG = {"medium_threshold": 45, "high_threshold": 65}
LABEL_COLUMNS = ("injected_anomaly", "is_fraud", "fraud", "label", "target", "class")


def _preprocessor():
    return ColumnTransformer([
        ("num", StandardScaler(), NUMERIC),
        ("cat", OneHotEncoder(handle_unknown="ignore"), ONEHOT),
    ])


def _classifiers():
    return {
        "Decision Tree": DecisionTreeClassifier(max_depth=8, class_weight="balanced", random_state=42),
        "Random Forest": RandomForestClassifier(n_estimators=120, max_depth=10,
            class_weight="balanced", random_state=42, n_jobs=-1),
        "SVM": SVC(class_weight="balanced", probability=True, random_state=42),
        "K-Nearest Neighbours": KNeighborsClassifier(n_neighbors=7),
    }


def _binary_labels(series):
    if series.name == "injected_anomaly":
        return series.notna().astype(int)
    if pd.api.types.is_bool_dtype(series):
        return series.astype(int)
    numeric = pd.to_numeric(series, errors="coerce")
    if numeric.notna().all() and numeric.nunique() <= 2:
        unique = sorted(numeric.unique())
        return numeric.eq(unique[-1]).astype(int)
    positive = {"1", "true", "yes", "fraud", "fraudulent", "anomaly", "suspicious", "positive"}
    normalized = series.astype("string").str.strip().str.lower()
    return normalized.isin(positive).astype(int)


def _load_training_data(data_path, labels_path, using_default):
    transactions = pd.read_csv(data_path)
    if labels_path:
        labels = pd.read_csv(labels_path)
        if "transaction_id" not in labels or "injected_anomaly" not in labels:
            raise ValueError("A separate labels CSV must contain transaction_id and injected_anomaly columns.")
        merged = transactions.merge(labels[["transaction_id", "injected_anomaly"]],
                                    on="transaction_id", validate="one_to_one")
        y = _binary_labels(merged["injected_anomaly"])
        return merged.drop(columns="injected_anomaly"), y, os.path.basename(labels_path)

    label_column = next((col for col in LABEL_COLUMNS if col in transactions.columns), None)
    if label_column:
        y = _binary_labels(transactions[label_column])
        return transactions.drop(columns=label_column), y, label_column

    if using_default:
        default_labels = os.path.join(HERE, "dataset", "sample_ground_truth.csv")
        return _load_training_data(data_path, default_labels, False)
    return transactions, None, None


def _train_supervised(df, y):
    if y.nunique() != 2 or int(y.sum()) < 2 or int((y == 0).sum()) < 2:
        raise ValueError("Labeled training requires at least two normal and two positive examples.")
    train_idx, val_idx = train_test_split(np.arange(len(df)), test_size=.25,
                                         random_state=42, stratify=y)
    train_df, _ = clean(df.iloc[train_idx])
    val_df, _ = clean(df.iloc[val_idx])
    profile = build_profile(train_df)
    X_train, X_val = build_features(train_df, profile), build_features(val_df, profile)
    y_train, y_val = y.iloc[train_idx], y.iloc[val_idx]

    scores = {}
    for name, classifier in _classifiers().items():
        candidate = Pipeline([("pre", _preprocessor()), ("model", classifier)])
        candidate.fit(X_train, y_train)
        scores[name] = float(f1_score(y_val, candidate.predict(X_val), zero_division=0))
    selected_name = max(scores, key=scores.get)

    full_df, _ = clean(df)
    full_profile = build_profile(full_df)
    X_full = build_features(full_df, full_profile)
    final_model = Pipeline([("pre", _preprocessor()),
                            ("model", _classifiers()[selected_name])]).fit(X_full, y)
    metadata = {"model": selected_name, "model_type": "supervised_classifier",
                "selection_metric": "F1-score", "selection_score": round(scores[selected_name], 4),
                "validation_scores": {k: round(v, 4) for k, v in scores.items()},
                "training_rows": len(full_df), "positive_rows": int(y.sum()),
                "label_note": "Labels are supplied dataset outcomes; verify their quality and meaning."}
    return final_model, full_profile, {"low": 0.0, "high": 1.0}, metadata


def _train_unsupervised(df, contamination):
    full_df, _ = clean(df)
    profile = build_profile(full_df)
    X = build_features(full_df, profile)
    model = Pipeline([("pre", _preprocessor()),
                      ("model", IsolationForest(n_estimators=300, contamination=contamination,
                                                random_state=42, n_jobs=-1))]).fit(X)
    raw_scores = -model.score_samples(X)
    ref = {"low": float(np.percentile(raw_scores, 50)),
           "high": float(np.percentile(raw_scores, 99.9))}
    metadata = {"model": "Isolation Forest", "model_type": "unsupervised_anomaly_detector",
                "contamination": contamination, "training_rows": len(full_df),
                "label_note": "No labels supplied; alerts rank unusual patterns, not known fraud."}
    return model, profile, ref, metadata


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=None, help="CSV with required transaction columns; optional label column.")
    ap.add_argument("--labels", default=None, help="Optional separate labels CSV with transaction_id and injected_anomaly.")
    ap.add_argument("--contamination", type=float, default=0.06)
    args = ap.parse_args()
    if not 0 < args.contamination <= 0.5:
        raise ValueError("contamination must be greater than 0 and at most 0.5")

    using_default = args.data is None
    data_path = args.data or os.path.join(HERE, "dataset", "sample_transactions.csv")
    df, y, label_source = _load_training_data(data_path, args.labels, using_default)
    if y is not None:
        pipeline, profile, score_ref, metadata = _train_supervised(df, y)
        metadata["labels_from"] = label_source
    else:
        pipeline, profile, score_ref, metadata = _train_unsupervised(df, args.contamination)
        metadata.update({"contamination": args.contamination,
                         "features_numeric": NUMERIC, "features_categorical": ONEHOT})
    metadata["trained_on"] = os.path.basename(data_path)

    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    joblib.dump({"pipeline": pipeline, "profile": profile, "score_ref": score_ref,
                 "metadata": metadata}, MODEL_PATH)
    if not os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "w", encoding="utf-8") as config_file:
            json.dump(DEFAULT_CONFIG, config_file, indent=2)
    print(f"Selected {metadata['model']} from {'labeled' if y is not None else 'unlabeled'} data.")
    if y is not None:
        print("Validation F1 scores:", metadata["validation_scores"])
    print(f"Saved model trained on {metadata['training_rows']} rows -> {MODEL_PATH}")


if __name__ == "__main__":
    main()
