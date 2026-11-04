"""Streamlit interface for the FraudShield transaction risk model."""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import streamlit as st

ROOT = Path(__file__).resolve().parent
ML_SERVICE = ROOT / "ml-service"
sys.path.insert(0, str(ML_SERVICE))

from predict import Predictor  # noqa: E402
from preprocessing.features import REQUIRED_COLUMNS, ValidationError  # noqa: E402


st.set_page_config(page_title="FraudShield", page_icon="F", layout="wide")


@st.cache_resource
def load_predictor():
    return Predictor()


st.title("FraudShield")
st.caption("Suspicious transaction screening using the project's trained ML model")

try:
    predictor = load_predictor()
except Exception as exc:
    st.error(f"Could not load the model: {exc}")
    st.info("Confirm that ml-service/models/selected_model.joblib and config.json are committed to GitHub.")
    st.stop()

info = predictor.info()
model_type = info.get("model_type", "Trained model")
col_a, col_b = st.columns(2)
col_a.metric("Active model", str(info.get("model_name", model_type)))
col_b.metric("Model type", str(model_type).replace("_", " ").title())
st.caption(predictor.disclaimer)

single_tab, batch_tab, details_tab = st.tabs(["Predict transaction", "Upload CSV", "Model details"])

with single_tab:
    st.subheader("Analyze one transaction")
    with st.form("single_prediction"):
        c1, c2 = st.columns(2)
        with c1:
            transaction_id = st.text_input("Transaction ID", value="TXN-DEMO-001")
            user_id = st.text_input("User ID", value="USER-DEMO-001")
            amount = st.number_input("Amount (₹)", min_value=0.0, value=75000.0, step=500.0)
            transaction_type = st.selectbox("Transaction type", ["transfer", "payment", "purchase", "withdrawal", "deposit"])
            timestamp = st.text_input("Timestamp", value="2026-11-05 23:00:00", help="Use a date and time, for example 2026-11-05 23:00:00")
        with c2:
            location = st.text_input("Location", value="Mumbai")
            merchant_category = st.text_input("Merchant category", value="online")
            account_age_days = st.number_input("Account age (days)", min_value=0.0, value=10.0, step=1.0)
            transaction_frequency = st.number_input("Transaction frequency", min_value=0.0, value=2.0, step=1.0)
        submitted = st.form_submit_button("Predict risk", type="primary", use_container_width=True)

    if submitted:
        tx = pd.DataFrame([{
            "transaction_id": transaction_id.strip() or "TXN-DEMO-001",
            "user_id": user_id.strip() or "USER-DEMO-001",
            "amount": amount,
            "transaction_type": transaction_type,
            "timestamp": timestamp,
            "location": location,
            "merchant_category": merchant_category,
            "account_age_days": account_age_days,
            "transaction_frequency": transaction_frequency,
        }])
        try:
            results, _ = predictor.predict_df(tx)
            result = results[0]
            if result["risk_level"] == "HIGH":
                st.error(f"HIGH RISK — score {result['risk_score']}/100")
            elif result["risk_level"] == "MEDIUM":
                st.warning(f"MEDIUM RISK — score {result['risk_score']}/100")
            else:
                st.success(f"LOW RISK — score {result['risk_score']}/100")
            st.write("**Transaction:**", result["transaction_id"])
            st.write("**Recommended action:**", result["recommended_action"])
            st.write("**Reasons:**", ", ".join(result["reasons"]) if result["reasons"] else "No flagged indicators")
            with st.expander("Full model result"):
                st.json(result)
        except (ValidationError, ValueError, TypeError) as exc:
            st.error(f"Could not analyze this transaction: {exc}")

with batch_tab:
    st.subheader("Analyze transactions from CSV")
    st.write("CSV must include: " + ", ".join(REQUIRED_COLUMNS))
    uploaded = st.file_uploader("Choose a transaction CSV", type=["csv"])
    if uploaded is not None:
        try:
            frame = pd.read_csv(uploaded)
            missing = [name for name in REQUIRED_COLUMNS if name not in frame.columns]
            if missing:
                st.error("Missing required columns: " + ", ".join(missing))
            else:
                st.dataframe(frame.head(10), use_container_width=True)
                if st.button("Analyze CSV", type="primary"):
                    results, report = predictor.predict_df(frame)
                    output = pd.DataFrame(results)
                    st.metric("Transactions analyzed", len(output))
                    st.metric("Flagged for review", int(output["is_suspicious"].sum()))
                    st.dataframe(output, use_container_width=True)
                    st.download_button("Download predictions", output.to_csv(index=False), "fraudshield_predictions.csv", "text/csv")
                    if report.get("imputed"):
                        st.info(f"Missing or invalid values were filled for: {report['imputed']}")
        except Exception as exc:
            st.error(f"Could not read or analyze the CSV: {exc}")

with details_tab:
    st.subheader("Model details")
    st.json(info)
    st.caption("Risk scores are screening signals, not verified fraud probabilities. Review flagged transactions.")
