# Shop migration fixture

`source/` contains six annotated Python modules. `base` and `labels` can start independently. `discounts` and `shipping` depend on `base`; `totals` joins their results; `receipt` joins `totals` and `labels`.

All prices are integer cents. Integer inputs and intermediate results must fit signed int64. This includes the product `count * price` and final totals. Names are Unicode strings. Negative quantities/prices are deliberate arithmetic edge cases, rather than validated business inputs.

`visible.json` contains six development cases. `holdout.json` contains eleven fixed final-evaluation cases, including negative floor division, zero quantities, Unicode, and non-VIP orders. Workers must only receive visible cases during a scored run.

`expected_go/` contains trusted prerecorded translations for the offline worker. They intentionally use the exact generated contract symbols. Offline runs test scheduling, evaluation, and integration; they are not evidence of LLM translation quality. The planner's Go scaffold includes unimplemented stubs and a JSON-lines bridge; the offline worker replaces only the task-owned module stubs.
