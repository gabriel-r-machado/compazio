-- A request sent with `ask --wait` is consumed synchronously by the caller's own CLI. Recording that
-- on the request lets the response skip the delivery message it would otherwise enqueue back into
-- the sender's terminal, which the waiting agent would read as a brand new instruction.
ALTER TABLE agent_messages ADD COLUMN awaited_by_sender integer NOT NULL DEFAULT 0;
