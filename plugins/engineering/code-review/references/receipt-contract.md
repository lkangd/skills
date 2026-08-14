Your entire final message must be exactly one fenced ```json code block containing a
completion receipt object — no prose before or after it. Set `status` to the exact ASCII value
`completed` and `findings` to the finding array. Nothing qualifies after a genuine pass =
`{"status":"completed","findings":[]}`; never return a bare empty array. The JSON keys,
`completed`, and the severity values are machine-parsed ASCII protocol: never translate them,
whatever language you review in; string values may be in any language. The `findings` array
uses this schema:
