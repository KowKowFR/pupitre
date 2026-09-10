import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** Page annoncée dans la navigation mais implémentée à un jalon ultérieur. */
export function Placeholder({ title, milestone }: { title: string; milestone: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>Cette section arrive au {milestone}.</CardDescription>
      </CardHeader>
      <CardContent className="text-[0.8125rem] text-ink-muted">
        Le jalon 2 ne couvre que l&apos;identité, le RBAC et la traçabilité.
      </CardContent>
    </Card>
  );
}
