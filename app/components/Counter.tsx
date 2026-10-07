"use client";

import { useReducer } from "react";

interface state {
  count: number;
}

type Action = { type: "increment" } | { type: "decrement" } | { type: "reset" };

const reducer = (state: state, action: Action): state => {
  switch (action.type) {
    case "increment":
      return { count: state.count + 1 };
    case "decrement":
      return { count: state.count - 1 };
    case "reset":
      return { count: 0 };
    default:
      throw new Error("unknown action");
  }
};

const Counter = () => {
  const [state, dispatch] = useReducer(reducer, { count: 0 });

  return (
    <div className="flex flex-col items-center gap-2 p-4">
      <h2 className="text-xl font-bold">Count: {state.count}</h2>
      <div className="flex gap-2">
        <button
          onClick={() => dispatch({ type: "increment" })}
          className="px-3 py-1 bg-black text-white rounded"
        >
          +
        </button>
        <button
          onClick={() => dispatch({ type: "decrement" })}
          className="px-3 py-1 bg-red-500 text-white rounded"
        >
          -
        </button>
        <button
          onClick={() => dispatch({ type: "reset" })}
          className="px-3 py-1 bg-gray-500 text-white rounded"
        >
          reset
        </button>
      </div>
    </div>
  );
};

export default Counter;
