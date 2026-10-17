// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
import { memo } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  experimental_useRpcMutation,
  experimental_useRpcQuery,
  experimental_useRpcKeyedQuery,
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

it("releases a stuck mutation with an error and permits Retry", async () => {
  vi.useFakeTimers();
  try {
    let stuck = true;
    function Probe() {
      const mutation = experimental_useRpcMutation({ method: "save" });
      return (
        <button
          disabled={mutation.isPending}
          onClick={() => void mutation.mutate({}).catch(() => {})}
        >
          {mutation.error?.message ?? (mutation.isPending ? "Saving" : "Save")}
        </button>
      );
    }
    const slot = renderSlot(
      { component: Probe },
      {},
      {
        rpc: { save: () => (stuck ? new Promise(() => {}) : "saved") },
      },
    );
    const button = slot.getByRole("button");
    await act(async () => {
      button.click();
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(button.textContent).toBe("Saving");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_001);
    });
    expect(button.textContent).toBe('RPC "save" timed out after 20 seconds');
    expect(button.hasAttribute("disabled")).toBe(false);
    stuck = false;
    await act(async () => {
      button.click();
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(button.textContent).toBe("Save");
  } finally {
    vi.useRealTimers();
  }
});

it("exposes a stuck read error and recovers through Retry", async () => {
  vi.useFakeTimers();
  try {
    let stuck = true;
    function Probe() {
      const query = experimental_useRpcQuery({ method: "read", input: {} });
      return (
        <button
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.error?.message ?? query.data?.toString() ?? "Loading"}
        </button>
      );
    }
    const slot = renderSlot(
      { component: Probe },
      {},
      {
        rpc: { read: () => (stuck ? new Promise(() => {}) : "loaded") },
      },
    );
    const button = slot.getByRole("button");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(button.textContent).toBe('RPC "read" timed out after 20 seconds');
    expect(button.hasAttribute("disabled")).toBe(false);
    stuck = false;
    await act(async () => {
      button.click();
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(button.textContent).toBe("loaded");
  } finally {
    vi.useRealTimers();
  }
});
