// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { memo } from "react";
import { QueryClient } from "@tanstack/react-query";
import { createRpcQueryHooks } from "../../internal/rpc-query-host.js";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { experimental_useRpcKeyedQuery } from "../../app.js";
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

it("retains plain and keyed watched reads until their consumers disable them", async () => {
  const client = new QueryClient();
  const releases: ReturnType<typeof vi.fn>[] = [];
  const watch = vi.fn(() => {
    const release = vi.fn();
    releases.push(release);
    return release;
  });
  const host = {
    pluginId: "demo",
    queryClient: client,
    subscribe: () => () => {},
    watch,
    call: async (_plugin: string, method: string) => ({
      result: method === "rows" ? { a: 1, b: 2 } : { ready: true },
      whileWatched: true,
    }),
  };
  const hooks = createRpcQueryHooks(() => host);
  const probe = renderHook(
    ({ enabled }) => {
      const plain = hooks.experimental_useRpcQuery({
        method: "read",
        input: { v: 1 },
        enabled,
      });
      hooks.experimental_useRpcKeyedQuery({
        method: "rows",
        keys: ["a", "b"],
        enabled,
      });
      return plain;
    },
    { initialProps: { enabled: true } },
  );
  try {
    await waitFor(() => expect(watch).toHaveBeenCalledTimes(3));
    expect(watch.mock.calls).toEqual(
      expect.arrayContaining([
        ["demo", "read", { input: { v: 1 } }],
        ["demo", "rows", { key: "a" }],
        ["demo", "rows", { key: "b" }],
      ]),
    );
    expect(probe.result.current.data).toEqual({ ready: true });
    probe.rerender({ enabled: false });
    for (const release of releases) expect(release).toHaveBeenCalledOnce();
  } finally {
    probe.unmount();
    client.clear();
  }
});
