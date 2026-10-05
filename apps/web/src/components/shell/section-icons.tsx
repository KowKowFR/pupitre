import {
  Activity,
  Boxes,
  Gauge,
  Globe,
  KeyRound,
  LayoutGrid,
  Radar,
  RadioTower,
  Rocket,
  ScrollText,
  Server,
  SlidersHorizontal,
  Timer,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { SectionKey } from '@/lib/navigation';

/** Each section's icon — the same in the rail, the palette and the breadcrumb. */
export const SECTION_ICON: Record<SectionKey, LucideIcon> = {
  dashboard: Gauge,
  targets: Server,
  applications: Boxes,
  catalog: LayoutGrid,
  servers: Activity,
  deployments: Rocket,
  domains: Globe,
  monitoring: Radar,
  maintenance: Wrench,
  jobs: Timer,
  logs: ScrollText,
  users: Users,
  roles: KeyRound,
  statusPages: RadioTower,
  settings: SlidersHorizontal,
};
