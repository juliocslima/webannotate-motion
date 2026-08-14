.PHONY: install run test clean

install:
	python -m pip install -r requirements.txt

run:
	uvicorn app.main:app --reload

test:
	pytest -q
	node --check static/app.js
	node --check static/pose-analyzer.js
	node --check static/temporal-metrics.js
	node tests/test_temporal_metrics.mjs

clean:
	rm -f data/webannotate.db
