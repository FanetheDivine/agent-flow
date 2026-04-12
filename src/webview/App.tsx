import { FC, useState } from "react";
import { Test } from "./components/Test";

export const App: FC = () => {
  const [count, setCount] = useState(0);

  return (
    <div style={{ padding: 16, fontFamily: 'var(--vscode-font-family)', color: 'var(--vscode-foreground)' }}>
      <h2 style={{ marginTop: 0 }}>Agent Flow</h2>
      <p>Count: <strong>{count}</strong></p>
      <button
        onClick={() => setCount(c => c + 1)}
        style={{
          background: 'var(--vscode-button-background)',
          color: 'var(--vscode-button-foreground)',
          border: 'none',
          padding: '4px 12px',
          cursor: 'pointer',
          borderRadius: 2,
        }}
      >
        +1
      </button>
      <Test />
    </div>
  );
}
