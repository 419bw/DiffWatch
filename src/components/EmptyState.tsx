export default function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-ink-muted select-none p-8">
      <div className="text-7xl mb-6 opacity-30">📝</div>
      <h2 className="text-2xl mb-3 text-ink-base font-bold tracking-[0.2em] uppercase">
        AI Change Inspector
      </h2>
      <p className="text-sm text-ink-muted">
        从左侧选择一个文件查看变更
      </p>
      <p className="text-xs mt-2 opacity-60">
        或点击「选择仓库」开始
      </p>
    </div>
  );
}