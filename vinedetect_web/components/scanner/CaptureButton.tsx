type Props = {
  disabled: boolean;
  onClick: () => void;
};

export function CaptureButton({ disabled, onClick }: Props) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="h-14 w-full rounded-lg bg-white px-5 text-base font-semibold text-black transition active:scale-[0.99] disabled:opacity-40"
    >
      Scan now
    </button>
  );
}
