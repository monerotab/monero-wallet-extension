import presets from '../../shared/nodes.json';
import type { NodePreset } from './types';

export const NODE_PRESETS = presets as NodePreset[];
export function nodeById(id?: string | null): NodePreset | undefined { return id ? NODE_PRESETS.find(node => node.id === id) : undefined; }
/** Human node name for display; never shows an internal id. */
export function nodeLabel(id?: string | null): string { const node = nodeById(id); return node ? node.name : id ? 'Custom node' : 'No node selected'; }
