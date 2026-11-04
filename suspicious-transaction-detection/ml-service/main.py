"""FraudShield AI - ML service (FastAPI).  Run: uvicorn main:app --port 8000 --reload"""
import io, os
from typing import Any, Optional

import pandas as pd
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from predict import Predictor
from evaluate_models import evaluate_sample_models
from preprocessing.features import REQUIRED_COLUMNS, ValidationError

MAX_BATCH = 50_000
app = FastAPI(title="FraudShield AI - ML Service", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
                   allow_methods=["*"], allow_headers=["*"])
predictor: Optional[Predictor] = None


@app.on_event("startup")
def load_model():
    global predictor
    try:
        predictor = Predictor()
    except FileNotFoundError as e:
        print("WARNING:", e)


def get_predictor() -> Predictor:
    if predictor is None:
        raise HTTPException(503, "Model not loaded. Run `python train.py` and restart.")
    return predictor


class Transaction(BaseModel):
    transaction_id: str
    user_id: str
    amount: Optional[float] = None
    transaction_type: Optional[str] = None
    timestamp: Optional[str] = None
    location: Optional[str] = None
    merchant_category: Optional[str] = None
    account_age_days: Optional[float] = None
    transaction_frequency: Optional[float] = None


class Thresholds(BaseModel):
    medium_threshold: float = Field(ge=0, le=100)
    high_threshold: float = Field(ge=0, le=100)


class BatchRequest(BaseModel):
    transactions: list[Transaction]
    thresholds: Optional[Thresholds] = None


def _run(df: pd.DataFrame, thresholds=None):
    p = get_predictor()
    if len(df) == 0:
        raise HTTPException(422, "No transactions supplied.")
    if len(df) > MAX_BATCH:
        raise HTTPException(413, f"Batch too large (max {MAX_BATCH}).")
    try:
        return p.predict_df(df, thresholds)
    except ValidationError as e:
        raise HTTPException(422, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))


def _summary(results):
    n = len(results)
    s = sum(r["is_suspicious"] for r in results)
    return {"total": n, "suspicious": s, "high": sum(r["risk_level"] == "HIGH" for r in results),
            "medium": sum(r["risk_level"] == "MEDIUM" for r in results),
            "low": sum(r["risk_level"] == "LOW" for r in results)}


@app.get("/health")
def health():
    return {"status": "ok" if predictor else "model_not_loaded", "model_loaded": predictor is not None}


@app.get("/model/info")
def model_info():
    return get_predictor().info()


@app.get("/model/evaluation")
def model_evaluation():
    try:
        return evaluate_sample_models()
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(422, str(e))


@app.post("/predict")
def predict(tx: Transaction):
    results, _ = _run(pd.DataFrame([tx.model_dump()]))
    return results[0]


@app.post("/predict/batch")
def predict_batch(req: BatchRequest, include_summary: bool = True):
    df = pd.DataFrame([t.model_dump() for t in req.transactions])
    results, report = _run(df, req.thresholds.model_dump() if req.thresholds else None)
    return {"results": results, "summary": _summary(results), "cleaning": report,
            "disclaimer": get_predictor().disclaimer}


@app.post("/predict/csv")
async def predict_csv(file: UploadFile = File(...)):
    """Convenience endpoint: upload a CSV directly to the ML service."""
    if not (file.filename or "").lower().endswith(".csv"):
        raise HTTPException(415, "Only .csv files are accepted.")
    try:
        df = pd.read_csv(io.BytesIO(await file.read()))
    except Exception:
        raise HTTPException(422, "Could not parse CSV.")
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise HTTPException(422, f"Missing required columns: {', '.join(missing)}")
    results, report = _run(df)
    return {"results": results, "summary": _summary(results), "cleaning": report,
            "disclaimer": get_predictor().disclaimer}
