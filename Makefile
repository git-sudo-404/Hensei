.PHONY: test demo plan

test:
	PYTHONPATH=src python3 -m unittest discover -s tests -v

demo:
	PYTHONPATH=src python3 -m hensei demo --output runs/demo --workers 3 --inject-failure

plan:
	PYTHONPATH=src python3 -m hensei plan examples/shop/source --output tasks.json
