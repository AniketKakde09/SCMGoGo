```sh
# run frontend code
cd Frontend
npm install
npm run dsp:all

# run backend
cd backend
python3 -m venv .venv
source .venv/bin/activate
# windows path might differ
pip install -r requirements.txt
uvicorn app:app --reload
```
