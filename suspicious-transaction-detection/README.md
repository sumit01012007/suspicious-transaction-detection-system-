# FraudShield

FraudShield includes a browser dashboard, an Express API, and a FastAPI machine learning service.

## Start on Windows

Open three PowerShell terminals from this directory and run one command in each:

```powershell
cd .\ml-service
..\venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

```powershell
cd .\backend
node server.js
```

```powershell
cd .\frontend
..\venv\Scripts\python.exe -m http.server 3000 --bind 127.0.0.1
```

## URLs

- Dashboard: <http://localhost:3000>
- Backend API: <http://localhost:5000>
- ML API docs: <http://localhost:8000/docs>
- Backend health: <http://localhost:5000/api/health>
- ML health: <http://localhost:8000/health>

The backend requires Node.js 18 or newer and `npm install` in `backend/`. The ML service requires the dependencies in `ml-service/requirements.txt`; a committed model is already provided. If the virtual environment is missing, create one with `python -m venv venv`, activate it, and run `pip install -r ml-service/requirements.txt` from this directory. The dashboard is plain HTML, CSS, and JavaScript served by Python's built-in HTTP server.

## Dashboard analysis

The overview includes daily or monthly activity trends, a risk-band distribution, a score histogram, merchant-category exposure, date filtering, and a short data summary. The risk-threshold dialog updates the configured medium and high bands and can reanalyze saved transactions. Charts use the backend's analytics endpoints and reflect the current imported dataset. Amounts are displayed in INR, matching the sample data and model explanations.

The training workflow adapts to the training dataset: labeled data is split into training and validation sets, candidate supervised models are compared by F1, and the best is retrained on all labeled rows. Unlabeled data trains an Isolation Forest. The active model and training source are shown on the Model evaluation page. Scores depend on the quality and fit of the training data; they are not validated fraud probabilities. Treat flags as an investigation queue and validate with representative, confirmed outcomes before operational use.

To train on a different dataset, run `python train.py --data path/to/transactions.csv` from `ml-service/`. Include a supported binary label column such as `is_fraud`, `fraud`, `label`, or `target` to select a supervised model. For separate labels, pass `--labels path/to/labels.csv` with `transaction_id` and `injected_anomaly` columns. With no labels, training uses Isolation Forest. Restart the ML service after training. The choice is based on the training data; an unlabeled prediction CSV cannot tell the app which rows are actually fraud.

## Open local demo

The dashboard opens directly without sign-in. The local operator can view all imported transactions, upload CSV files, run analysis, review alerts, and change model thresholds. API routes are also open and do not enforce user roles or account-level data separation. Keep the services bound to localhost and use only demo data; do not expose this version to a network or use it for customer-impacting decisions.
