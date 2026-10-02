import {
  Activity,
  Boxes,
  Gauge,
  Globe,
  KeyRound,
  LayoutGrid,
  Radar,
  Rocket,
  ScrollText,
  Server,
  SlidersHorizontal,
  Timer,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { SectionKey } from '@/lib/navigation';

/** L'icône de chaque section — la même dans le rail, la palette et le fil d'Ariane. */
export const SECTION_ICON: Record<SectionKey, LucideIcon> = {
  dashboard: Gauge,
  targets: Server,
  applications: Boxes,
  catalog: LayoutGrid,
  servers: Activity,
  deployments: Rocket,
  domains: Globe,
  monitoring: Radar,
  jobs: Timer,
  logs: ScrollText,
  users: Users,
  roles: KeyRound,
  settings: SlidersHorizontal,
};
