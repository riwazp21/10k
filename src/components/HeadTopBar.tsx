"use client";

export default function HeadTopBar() {
  return (
    <div className="w-full border-b bg-white sticky top-0 z-10">
      <div className="max-w-3xl mx-auto px-6 py-3 flex items-center justify-between">
        <h1 className="text-lg font-bold">10k</h1>
        <span className="text-xs text-neutral-500">
          let's decode the financial realm
        </span>
      </div>
    </div>
  );
}
