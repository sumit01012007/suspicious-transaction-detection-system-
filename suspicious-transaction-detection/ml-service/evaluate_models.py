"""Evaluate syllabus models on the bundled, synthetic holdout labels."""
import os

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.metrics import (accuracy_score, confusion_matrix, f1_score,
                             precision_score, recall_score, roc_auc_score)
from sklearn.model_selection import train_test_split
from sklearn.neighbors import KNeighborsClassifier
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
from sklearn.svm import SVC
from sklearn.tree import DecisionTreeClassifier

from preprocessing.features import NUMERIC, ONEHOT, build_features, build_profile, clean

HERE = os.path.dirname(os.path.abspath(__file__))


def evaluate_sample_models():
    transactions = pd.read_csv(os.path.join(HERE, "dataset", "sample_transactions.csv"))
    labels = pd.read_csv(os.path.join(HERE, "dataset", "sample_ground_truth.csv"))
    merged = transactions.merge(labels, on="transaction_id", validate="one_to_one")
    y = merged["injected_anomaly"].notna().astype(int).to_numpy()
    if len(np.unique(y)) < 2 or min(np.bincount(y)) < 2:
        raise ValueError("The sample must contain normal and anomalous transactions.")
    train_idx, test_idx = train_test_split(np.arange(len(merged)), test_size=.25,
                                          random_state=42, stratify=y)
    train_df, _ = clean(merged.iloc[train_idx].drop(columns="injected_anomaly"))
    test_df, _ = clean(merged.iloc[test_idx].drop(columns="injected_anomaly"))
    profile = build_profile(train_df)
    X_train = build_features(train_df, profile)
    X_test = build_features(test_df, profile)
    y_train, y_test = y[train_idx], y[test_idx]
    prep = ColumnTransformer([
        ("num", StandardScaler(), NUMERIC),
        ("cat", OneHotEncoder(handle_unknown="ignore"), ONEHOT),
    ])
    models = {
        "Decision Tree": DecisionTreeClassifier(max_depth=8, class_weight="balanced", random_state=42),
        "Random Forest": RandomForestClassifier(n_estimators=120, max_depth=10, class_weight="balanced", random_state=42, n_jobs=-1),
        "SVM": SVC(class_weight="balanced", probability=True, random_state=42),
        "K-Nearest Neighbours": KNeighborsClassifier(n_neighbors=7),
    }
    results = []
    for name, classifier in models.items():
        model = Pipeline([("pre", prep), ("model", classifier)])
        model.fit(X_train, y_train)
        pred = model.predict(X_test)
        score = model.predict_proba(X_test)[:, 1]
        results.append(_metrics(name, y_test, pred, score, "supervised"))

    # Unsupervised baseline: fit only on training transactions, then rank the test
    # set and flag the top 6%, matching the documented contamination setting.
    iso = Pipeline([("pre", prep), ("model", IsolationForest(n_estimators=150,
                   contamination=.06, random_state=42, n_jobs=-1))])
    iso.fit(X_train)
    anomaly_score = -iso.score_samples(X_test)
    cutoff = np.quantile(anomaly_score, .94)
    pred = (anomaly_score >= cutoff).astype(int)
    results.insert(0, _metrics("Isolation Forest", y_test, pred, anomaly_score, "unsupervised"))
    selected = max((row for row in results if row["type"] == "supervised"), key=lambda row: row["f1"])
    return {"rows": len(merged), "train_rows": len(train_idx), "test_rows": len(test_idx),
            "anomalies": int(y.sum()), "results": results,
            "selected_model": {"name": selected["name"], "metric": "F1-score", "score": selected["f1"]},
            "notice": "Synthetic injected anomalies only. Holdout metrics are educational examples, not evidence of real-world fraud performance."}


def _metrics(name, truth, predicted, scores, kind):
    tn, fp, fn, tp = confusion_matrix(truth, predicted, labels=[0, 1]).ravel()
    return {"name": name, "type": kind, "accuracy": round(float(accuracy_score(truth, predicted)), 4),
            "precision": round(float(precision_score(truth, predicted, zero_division=0)), 4),
            "recall": round(float(recall_score(truth, predicted, zero_division=0)), 4),
            "f1": round(float(f1_score(truth, predicted, zero_division=0)), 4),
            "roc_auc": round(float(roc_auc_score(truth, scores)), 4),
            "confusion": {"true_negative": int(tn), "false_positive": int(fp),
                          "false_negative": int(fn), "true_positive": int(tp)}}
