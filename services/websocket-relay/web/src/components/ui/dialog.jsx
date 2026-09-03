import * as React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 최소한의 모달.
 * @radix-ui/react-dialog 를 새로 들이지 않으려고 직접 구현했다.
 * Esc / 배경 클릭으로 닫히고, 열려 있는 동안 뒤쪽 스크롤을 막는다.
 */
function Dialog({ open, onOpenChange, children, className, labelledBy }) {
  const contentRef = React.useRef(null);

  /*
   * onOpenChange 를 의존성에 두지 않는다.
   *
   * 부르는 쪽이 인라인 화살표 함수를 넘기는 일이 흔한데(ComplexCard 가 그렇다),
   * 그러면 렌더할 때마다 함수의 정체가 달라져 아래 효과가 매번 다시 돈다.
   * 효과 안에 "열릴 때 초점을 옮긴다" 가 들어 있으므로, 글자 하나를 칠 때마다
   * 초점이 입력란 밖으로 튀어 **입력이 이어지지 않았다.**
   *
   * 최신 값은 ref 로 들고 있으면 되고, 효과는 open 이 바뀔 때만 돌면 된다.
   */
  const onOpenChangeRef = React.useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  React.useEffect(() => {
    if (!open) return undefined;

    function onKeyDown(e) {
      if (e.key === 'Escape') onOpenChangeRef.current(false);
    }

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    /*
     * 열리면 사람이 채울 첫 칸으로 초점을 옮긴다.
     *
     * 닫기(✕)는 건너뛴다. 그것이 DOM 에서 가장 앞에 있어서, 앞의 코드처럼
     * 한 줄로 훑으면 입력란이 아니라 ✕ 가 잡혔다. 입력란이 하나도 없는
     * 다이얼로그(확인만 하는 것)에서만 버튼으로 내려간다.
     */
    const root = contentRef.current;
    const target =
      root?.querySelector(
        'input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])'
      ) ?? root?.querySelector('button:not([data-dialog-close]):not([disabled])');
    target?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[10vh] backdrop-blur-sm"
      // 배경을 눌러 시작한 클릭만 닫는다. (안쪽에서 드래그해 나온 경우는 무시)
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={cn(
          'relative w-full max-w-sm rounded-xl border bg-card p-6 shadow-lg',
          className
        )}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

function DialogHeader({ className, ...props }) {
  return <div className={cn('mb-4 space-y-1.5', className)} {...props} />;
}

function DialogTitle({ className, ...props }) {
  return <h2 className={cn('text-base font-semibold leading-none tracking-tight', className)} {...props} />;
}

function DialogDescription({ className, ...props }) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

function DialogFooter({ className, ...props }) {
  return <div className={cn('mt-6 flex justify-end gap-2', className)} {...props} />;
}

function DialogClose({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="닫기"
      // 열릴 때 초점을 고르는 쪽이 이 버튼을 건너뛰는 표식 (위 Dialog 참고).
      data-dialog-close=""
      className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <X className="size-4" />
    </button>
  );
}

export { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose };
