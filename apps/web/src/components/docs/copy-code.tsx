'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/client';
import { docs as messages } from '@/i18n/messages/docs';
import { copyText } from '@/lib/secure-origin';

/** A code block's copy button: the command goes to the clipboard as it is shown. */
export function CopyCode({ text }: { text: string }) {
  const t = useT(messages);
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={async () => {
        if (!(await copyText(text))) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? t('code.copied') : t('code.copy')}
    </Button>
  );
}
