// @vitest-environment jsdom
import { act, cleanup, waitFor } from "@testing-library/react";
import { memo } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  experimental_useRpcKeyedQuery,
  experimental_useRpcQuery,
} from "../../app.js";
import { defineRpcContract } from "../../rpc-contract.js";
import { renderSlot } from "../app.js";

afterEach(cleanup);

it("updates selected load state without rendering unchanged rows again", async () => {
  const rendered = vi.fn();
  const Rows = memo(({ values }: { values: Record<string, number> }) => {
    rendered();
    return (
      <p>
        {Object.entries(values)
          .map(([key, value]) => `${key}:${value}`)
          .join(",")}
      </p>
    );
  });
  const select = (rows: Record<string, number>) => ({
    values: Object.fromEntries(
      Object.entries(rows).filter(([, value]) => value > 0),
    ),
    loaded: Object.keys(rows).length,
  });
  function Probe({ keys }: { keys: string[] }) {
    const query = experimental_useRpcKeyedQuery<
      number,
      ReturnType<typeof select>
    >({ method: "rows", keys, select });
    return (
      <>
        <Rows values={query.data?.values ?? {}} />
        <output>{query.data?.loaded ?? 0} loaded</output>
      </>
    );
  }
  const contract = defineRpcContract({
    rows: {
      input: z.object({ keys: z.array(z.string()) }),
      output: z.record(z.string(), z.number()),
      keyTags: (key) => [key],
    },
  });
  let release!: (rows: Record<string, number>) => void;
  const next = new Promise<Record<string, number>>((resolve) => {
    release = resolve;
  });
  const slot = renderSlot<{ keys: string[] }, typeof contract>(
    { component: Probe },
    { keys: ["a"] },
    {
      experimental_rpcContract: contract,
      rpc: { rows: ({ keys }) => (keys.includes("b") ? next : { a: 1 }) },
    },
  );
  await slot.findByText("a:1");
  const count = rendered.mock.calls.length;
  slot.rerender(<Probe keys={["a", "b"]} />);
  expect(rendered).toHaveBeenCalledTimes(count);
  await act(async () => {
    release({ b: 0 });
  });
  await slot.findByText("2 loaded");
  expect(rendered).toHaveBeenCalledTimes(count);
});

it("reports successful reads even when their data stays unchanged", async () => {
  const contract = defineRpcContract({
    value: { input: z.null(), output: z.number(), tags: () => ["value"] },
  });
  function Probe() {
    const query = experimental_useRpcQuery<typeof contract, "value">({
      method: "value",
      input: null,
    });
    return <output>{query.dataUpdatedAt}</output>;
  }
  const slot = renderSlot(
    { component: Probe },
    {},
    {
      experimental_rpcContract: contract,
      rpc: { value: () => 7 },
    },
  );
  await waitFor(() =>
    expect(Number(slot.container.textContent)).toBeGreaterThan(0),
  );
  const first = Number(slot.container.textContent);
  await slot.experimental_invalidateRpc(["value"]);
  await waitFor(() =>
    expect(Number(slot.container.textContent)).toBeGreaterThan(first),
  );
});
