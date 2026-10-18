# The `data_json` edit (paste into each agent's own CREAO chat)

The server sends each agent its data as one extra input, `data_json` (a JSON string), built from the server's own
questions, tone and family facts (`server/src/creao/input.ts`). Each agent needs this one edit to read it.

> Update this agent. Add one optional input field `data_json` (a JSON string). If it is provided, parse it and use it as the data instead of reading the seed files. Shape: {"days":[{"date":"YYYY-MM-DD","events":[...]}],"facts":[{"id":"...","question":"...","answer":"..."}]}. Events keep the same fields as the seed files (id, at, role, text, matched_fact_id, score, decision "answered" or "abstained", and an optional tone {top, worry, quality}). An event with no tone is still a real wearer question: count it and leave the tone out of any trend. If `data_json` is not provided, behave exactly as before using the seed files. Keep the output JSON, the rules and the wording unchanged.

Inputs the server sends per agent:

| Agent | Inputs |
| --- | --- |
| Daily brief | `date`, `data_json` (that one day) |
| Pattern finder | `end_date`, `data_json` (7 days) |
| Open Questions | `end_date`, `data_json` (7 days) |
| Care assistant | `role`, `request`, `today`, `data_json` (7 days and the family facts) |

Check after the edit: run the agent once with a small `data_json` that has an unmistakable question (for example "Where is my blue umbrella?" asked 5 times across a day) and confirm the output mentions it and still has `"schema_version": "1.0"`.
