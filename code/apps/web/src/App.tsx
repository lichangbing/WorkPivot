/** T1-03 起替换为三栏布局；当前仅验证 React+Tailwind 渲染链路。 */
export default function App(): React.JSX.Element {
  return (
    <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-100">
      <div className="text-center">
        <h1 className="text-3xl font-semibold">WorkPivot</h1>
        <p className="mt-2 text-sm text-neutral-400">脚手架就绪 · T1-01</p>
      </div>
    </div>
  );
}
