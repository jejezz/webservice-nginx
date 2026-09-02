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
   * 콜백을 ref 로 한 겹 감싼다.
   *
   * 이걸 의존성 배열에 직접 넣으면, 부모가 인라인 함수를 넘기는 순간
   * (Accounts.jsx 의 onOpenChange={reset} 처럼) **글자를 한 자 칠 때마다**
   * 함수 정체가 바뀌어 아래 효과가 다시 돈다. 그러면 초점이 매번 처음으로
   * 되돌아가 입력을 이어 갈 수 없다. 실제로 그렇게 깨져 있었다.
   */
  const onOpenChangeRef = React.useRef(onOpenChange);
  React.useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  });

  React.useEffect(() => {
    if (!open) return undefined;

    function onKeyDown(e) {
      if (e.key === 'Escape') onOpenChangeRef.current(false);
    }

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    /*
     * 열릴 때 한 번만, 안쪽 첫 **입력칸**으로 초점을 옮긴다.
     *
     * 예전에는 'input, select, textarea, button' 을 한 번에 찾았는데, 닫기(X)
     * 버튼이 DOM 에서 폼보다 앞에 있어서 늘 그쪽이 잡혔다. 입력칸을 먼저 찾고
     * 없을 때만 버튼으로 내려간다 (확인만 있는 대화상자를 위해).
     */
    const content = contentRef.current;
    const initial =
      content?.querySelector(
        'input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])'
      ) || content?.querySelector('button:not([disabled])');
    initial?.focus();

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
      className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <X className="size-4" />
    </button>
  );
}

export { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose };
