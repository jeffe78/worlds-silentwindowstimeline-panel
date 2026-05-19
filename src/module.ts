import { PanelPlugin } from '@grafana/data';
import { SilentWindowsTimelineOptions } from './types';
import { SilentWindowsTimelinePanel } from './components/SilentWindowsTimelinePanel';

export const plugin = new PanelPlugin<SilentWindowsTimelineOptions>(SilentWindowsTimelinePanel).setPanelOptions(
  (builder) => builder
);
