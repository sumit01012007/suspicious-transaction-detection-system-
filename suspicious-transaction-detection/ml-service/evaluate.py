"""Sanity-check the model against the synthetic ground truth (never seen during training)."""
import pandas as pd
from predict import Predictor

P = Predictor()
df = pd.read_csv("dataset/sample_transactions.csv")
res, _ = P.predict_df(df)
r = pd.DataFrame(res).merge(pd.read_csv("dataset/sample_ground_truth.csv"), on="transaction_id")
r["truth"] = r["injected_anomaly"].notna()
f = r["is_suspicious"]
tp = int((f & r.truth).sum())
print(f"Flagged {int(f.sum())}/{len(r)} | precision {tp / max(int(f.sum()), 1):.2f} | recall {tp / int(r.truth.sum()):.2f}")
print(r[r.truth].groupby("injected_anomaly")["is_suspicious"].mean().round(2).rename("detection rate by anomaly type"))
print("Note: injected anomalies are synthetic; real-world performance will differ.")
