import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Search,
  Activity,
  Layers,
  ArrowRightLeft,
  X,
  AlertTriangle,
  FolderOpen,
  Info,
  Check,
  ChevronRight,
  Focus,
  BookOpen,
} from 'lucide-react';

import { SemanticModel, Symbol, ResolvedReference } from './types';
import {
  buildGraph,
  buildModuleGraph,
  buildServiceGraph,
  buildApiGraph,
  buildDataGraph,
  traceFlow,
  SemanticGraph,
} from './utils/graph-model';
import { getSymbolTheme } from './components/symbol-theme';
import { ForceGraphCanvas, FocusRequest } from './components/ForceGraphCanvas';

const EMPTY_GRAPH: SemanticGraph = {
  nodes: [],
  links: [],
  nodeById: new Map(),
  parentOf: new Map(),
  childrenOf: new Map(),
  neighborsOf: new Map(),
};

function LegendSection() {
  return (
    <div style={{ marginTop: 'auto', borderTop: '1px solid var(--border-color)', paddingTop: 20, width: '100%' }}>
      <h4 style={{ fontFamily: 'var(--font-title)', margin: '0 0 16px 0', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)' }}>
        Graph Legend
      </h4>
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Node Types */}
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', marginBottom: 8 }}>Symbols (Nodes)</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[
              { label: 'File', color: '#0ea5e9' },
              { label: 'Class', color: '#a855f7' },
              { label: 'Interface', color: '#ec4899' },
              { label: 'Struct', color: '#14b8a6' },
              { label: 'Function', color: '#10b981' },
              { label: 'Method', color: '#f59e0b' },
              { label: 'Variable', color: '#f43f5e' },
              { label: 'Type Alias', color: '#6366f1' },
            ].map((item) => (
              <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: item.color, boxShadow: `0 0 4px ${item.color}` }}></div>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Edge Relations */}
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', marginBottom: 8 }}>Relations (Edges)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { label: 'Call (Func/Method)', color: '#10b981', style: 'solid', desc: 'glowing solid' },
              { label: 'Instantiate (Class/Struct)', color: '#f59e0b', style: 'solid', desc: 'glowing solid' },
              { label: 'Import Specifier', color: '#0ea5e9', style: 'dashed', desc: 'dashed' },
              { label: 'Inherit / Implement', color: '#a855f7', style: 'dotted', desc: 'dotted' },
              { label: 'Containment', color: 'rgba(255, 255, 255, 0.15)', style: 'dashed', desc: 'faint dashed' },
            ].map((item) => (
              <div key={item.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11.5 }}>
                <span>{item.label}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{item.desc}</span>
                  <div 
                    style={{ 
                      width: 30, 
                      height: item.style === 'solid' ? 2 : 0, 
                      borderTop: item.style !== 'solid' ? `1px ${item.style} ${item.color}` : 'none',
                      backgroundColor: item.style === 'solid' ? item.color : 'transparent',
                    }} 
                  />
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
            Arrowheads point from caller → callee. Hover or click a node to dim the graph down to
            that node and its direct neighbours. The graph opens at module level — a dashed ring
            means a node still holds hidden symbols; click it or zoom in to reveal them.
          </div>
        </div>
      </div>
    </div>
  );
}

function VisualizerDashboard() {
  // Model & Loading state
  const [model, setModel] = useState<SemanticModel | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search & Filtering State
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedKinds, setSelectedKinds] = useState<Set<string>>(new Set());
  const [selectedEdgeKinds, setSelectedEdgeKinds] = useState<Set<string>>(new Set());

  // Interactive selection state
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [neighborhoodNodeId, setNeighborhoodNodeId] = useState<string | null>(null);

  // Viewport centering requests raised from the sidebars (the canvas owns positions)
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const focusNonce = useRef(0);

  // View mode selection
  type ViewMode = 'flat' | 'module' | 'service' | 'api' | 'data';
  const [viewMode, setViewMode] = useState<ViewMode>('flat');

  // Active Execution Flow Trace
  const [activeTraceStartId, setActiveTraceStartId] = useState<string | null>(null);
  const [traceDepth, setTraceDepth] = useState<number>(4);

  // Load model JSON
  useEffect(() => {
    fetch('/api/model')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch semantic model');
        return res.json();
      })
      .then((data: SemanticModel) => {
        setModel(data);
        setIsLoading(false);

        // Initialize active filters
        const kinds = new Set(data.symbols.map((s) => s.kind));
        kinds.delete('project'); // project is a root virtual concept
        setSelectedKinds(kinds);

        const edgeKinds = new Set(data.resolvedReferences.map((r) => r.kind));
        setSelectedEdgeKinds(edgeKinds);
      })
      .catch((err) => {
        setError(err.message || 'Error loading model');
        setIsLoading(false);
      });
  }, []);

  // Map representation of symbols, containments & references for fast lookups
  const symbolMap = useMemo(() => {
    const map = new Map<string, Symbol>();
    if (!model) return map;
    for (const sym of model.symbols) {
      map.set(sym.id, sym);
    }
    return map;
  }, [model]);

  // Compute references maps for Inspector
  const referencesTo = useMemo(() => {
    const map = new Map<string, ResolvedReference[]>();
    if (!model) return map;
    for (const ref of model.resolvedReferences) {
      const list = map.get(ref.toSymbolId) || [];
      list.push(ref);
      map.set(ref.toSymbolId, list);
    }
    return map;
  }, [model]);

  const referencesFrom = useMemo(() => {
    const map = new Map<string, ResolvedReference[]>();
    if (!model) return map;
    for (const ref of model.resolvedReferences) {
      const list = map.get(ref.fromSymbolId) || [];
      list.push(ref);
      map.set(ref.fromSymbolId, list);
    }
    return map;
  }, [model]);

  // Derive counts for filter panel
  const counts = useMemo(() => {
    const kindCounts: Record<string, number> = {};
    const edgeCounts: Record<string, number> = {};

    if (model) {
      for (const s of model.symbols) {
        if (s.kind !== 'project') {
          kindCounts[s.kind] = (kindCounts[s.kind] || 0) + 1;
        }
      }
      for (const r of model.resolvedReferences) {
        edgeCounts[r.kind] = (edgeCounts[r.kind] || 0) + 1;
      }
    }

    return { kinds: kindCounts, edges: edgeCounts };
  }, [model]);

  // Build the graph for the active view mode / flow trace. Level of detail and
  // filtering are applied by the canvas on top of this.
  const currentGraph = useMemo<SemanticGraph>(() => {
    if (!model) return EMPTY_GRAPH;

    if (activeTraceStartId) {
      return traceFlow(model, activeTraceStartId, traceDepth);
    }

    switch (viewMode) {
      case 'module':
        return buildModuleGraph(model);
      case 'service':
        return buildServiceGraph(model);
      case 'api':
        return buildApiGraph(model);
      case 'data':
        return buildDataGraph(model);
      case 'flat':
      default:
        return buildGraph(model);
    }
  }, [model, viewMode, activeTraceStartId, traceDepth]);

  // Handle sidebar navigation click — the canvas owns live positions, so we just
  // raise a focus request and let it do the centering.
  const selectAndFocusNode = useCallback((id: string) => {
    setSelectedNodeId(id);
    focusNonce.current += 1;
    setFocusRequest({ id, nonce: focusNonce.current });
  }, []);

  // Filter handlers
  const toggleKindFilter = (kind: string) => {
    const next = new Set(selectedKinds);
    if (next.has(kind)) {
      next.delete(kind);
    } else {
      next.add(kind);
    }
    setSelectedKinds(next);
  };

  const toggleEdgeFilter = (kind: string) => {
    const next = new Set(selectedEdgeKinds);
    if (next.has(kind)) {
      next.delete(kind);
    } else {
      next.add(kind);
    }
    setSelectedEdgeKinds(next);
  };

  // Node Inspector selection
  const selectedSymbol = useMemo(() => {
    if (!selectedNodeId) return null;
    const node = currentGraph.nodeById.get(selectedNodeId);
    return node?.symbol ?? symbolMap.get(selectedNodeId) ?? null;
  }, [selectedNodeId, currentGraph, symbolMap]);

  const selectedRelations = useMemo(() => {
    if (!selectedNodeId) return null;

    const from = referencesFrom.get(selectedNodeId) || [];
    const to = referencesTo.get(selectedNodeId) || [];

    return {
      referencesMade: from.map((ref) => ({
        ref,
        targetSymbol: symbolMap.get(ref.toSymbolId)!,
      })).filter(item => item.targetSymbol !== undefined),
      referencesReceived: to.map((ref) => ({
        ref,
        sourceSymbol: symbolMap.get(ref.fromSymbolId)!,
      })).filter(item => item.sourceSymbol !== undefined),
    };
  }, [selectedNodeId, referencesFrom, referencesTo, symbolMap]);

  // Loading Screens
  if (isLoading) {
    return (
      <div className="loading-overlay">
        <div className="spinner"></div>
        <div className="loading-text">Building Knowledge Graph Visualizer...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="loading-overlay">
        <AlertTriangle size={48} color="#ef4444" />
        <div className="loading-text" style={{ color: '#ef4444', marginTop: 12 }}>
          {error}
        </div>
      </div>
    );
  }

  if (!model) return null;

  return (
    <div className="app-container">
      {/* LEFT SIDEBAR: Search, Filters & Diagnostics */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>
            <Activity size={18} color="#3b82f6" />
            <span>Creed</span>
          </h1>

          {/* View Selector Segments */}
          <div className="view-selector-tabs">
            {(['flat', 'module', 'service', 'api', 'data'] as const).map((mode) => (
              <button
                key={mode}
                className={`view-tab-btn ${viewMode === mode ? 'active' : ''}`}
                onClick={() => {
                  setViewMode(mode);
                  setActiveTraceStartId(null); // Clear active trace on view change
                  setSelectedNodeId(null);
                }}
              >
                {mode === 'flat' ? 'Flat' : mode === 'module' ? 'Modules' : mode === 'service' ? 'Services' : mode === 'api' ? 'APIs' : 'Data'}
              </button>
            ))}
          </div>
          
          <div className="search-container">
            <Search className="search-icon" size={16} />
            <input
              type="text"
              className="search-input"
              placeholder="Search symbols..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                style={{
                  position: 'absolute',
                  right: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="sidebar-content">
          {/* Stats widget */}
          <div className="section-card">
            <div className="section-title">
              <span>Workspace Stats</span>
              <Activity size={14} color="var(--text-muted)" />
            </div>
            <div className="stats-grid">
              <div className="stat-box">
                <div className="stat-val">{model.fileCount}</div>
                <div className="stat-label">Files</div>
              </div>
              <div className="stat-box">
                <div className="stat-val">{model.symbolCount}</div>
                <div className="stat-label">Symbols</div>
              </div>
              <div className="stat-box">
                <div className="stat-val">{model.resolvedReferences.length}</div>
                <div className="stat-label">Resolved Refs</div>
              </div>
              <div className="stat-box" style={{ borderColor: model.diagnostics.length > 0 ? '#f59e0b' : 'var(--border-color)' }}>
                <div className="stat-val" style={{ color: model.diagnostics.length > 0 ? '#f59e0b' : 'var(--text-primary)' }}>
                  {model.diagnostics.length}
                </div>
                <div className="stat-label">Diagnostics</div>
              </div>
            </div>
          </div>

          {/* Symbol Filter Badges */}
          <div className="section-card">
            <div className="section-title">
              <span>Filter Symbols</span>
              <Layers size={14} color="var(--text-muted)" />
            </div>
            <div className="filters-list">
              {Object.entries(counts.kinds).map(([kind, count]) => {
                const { color } = getSymbolTheme(kind);
                const isChecked = selectedKinds.has(kind);
                return (
                  <div key={kind} className="filter-item" onClick={() => toggleKindFilter(kind)}>
                    <div className="filter-label">
                      <div className={`checkbox-custom ${isChecked ? 'checked' : ''}`}>
                        {isChecked && <Check size={10} color="white" />}
                      </div>
                      <div className="dot-indicator" style={{ backgroundColor: color }}></div>
                      <span style={{ textTransform: 'capitalize' }}>{kind.replace('_', ' ')}s</span>
                    </div>
                    <div className="count-badge">{count}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Edge Filter Badges */}
          <div className="section-card">
            <div className="section-title">
              <span>Filter Relations</span>
              <ArrowRightLeft size={14} color="var(--text-muted)" />
            </div>
            <div className="filters-list">
              {Object.entries(counts.edges).map(([kind, count]) => {
                const isChecked = selectedEdgeKinds.has(kind);
                return (
                  <div key={kind} className="filter-item" onClick={() => toggleEdgeFilter(kind)}>
                    <div className="filter-label">
                      <div className={`checkbox-custom ${isChecked ? 'checked' : ''}`}>
                        {isChecked && <Check size={10} color="white" />}
                      </div>
                      <span style={{ textTransform: 'capitalize' }}>{kind.replace('_', ' ')}</span>
                    </div>
                    <div className="count-badge">{count}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Diagnostics warning panel if warnings exist */}
          {model.diagnostics.length > 0 && (
            <div className="section-card" style={{ borderColor: 'rgba(245, 158, 11, 0.3)' }}>
              <div className="section-title" style={{ color: '#f59e0b' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AlertTriangle size={14} />
                  Diagnostics ({model.diagnostics.length})
                </span>
              </div>
              <div className="file-list" style={{ gap: 10 }}>
                {model.diagnostics.map((diag, index) => (
                  <div key={index} className={`diagnostic-item ${diag.severity}`}>
                    <div className="diagnostic-header">
                      <span>{diag.kind.replace('_', ' ')}</span>
                      <span style={{ fontSize: 9, textTransform: 'uppercase', opacity: 0.8 }}>{diag.severity}</span>
                    </div>
                    <div className="diagnostic-msg">{diag.message}</div>
                    <div className="diagnostic-path">{diag.filePath}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Quick File List Navigator */}
          <div className="section-card">
            <div className="section-title">
              <span>Codebase Files</span>
              <FolderOpen size={14} color="var(--text-muted)" />
            </div>
            <div className="file-list">
              {model.symbols
                .filter((s) => s.kind === 'file')
                .map((file) => (
                  <div key={file.id} className="file-item" onClick={() => selectAndFocusNode(file.id)}>
                    <ChevronRight size={12} color="var(--text-muted)" />
                    <span>{file.name}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </aside>

      {/* CENTER: React Flow Canvas */}
      <main className="canvas-container">
        {activeTraceStartId && (
          <div
            style={{
              position: 'absolute',
              top: 20,
              left: 20,
              zIndex: 5,
              background: 'rgba(16, 185, 129, 0.15)',
              border: '1px solid #10b981',
              borderRadius: '24px',
              padding: '8px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontSize: 12.5,
              color: '#a7f3d0',
              backdropFilter: 'blur(10px)',
              boxShadow: '0 4px 15px rgba(0,0,0,0.35)',
            }}
          >
            <Activity size={14} color="#10b981" />
            <span>
              Flow Trace Active (Depth: <strong>{traceDepth}</strong>)
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => setTraceDepth(d => d + 2)}
                className="action-btn"
                style={{ width: 'auto', padding: '2px 8px', fontSize: 11, background: 'rgba(255,255,255,0.1)' }}
              >
                +2 Depth
              </button>
              <button
                onClick={() => setTraceDepth(d => Math.max(2, d - 2))}
                className="action-btn"
                style={{ width: 'auto', padding: '2px 8px', fontSize: 11, background: 'rgba(255,255,255,0.1)' }}
              >
                -2 Depth
              </button>
              <button
                onClick={() => {
                  setActiveTraceStartId(null);
                  setTraceDepth(4);
                }}
                style={{
                  background: 'rgba(239, 68, 68, 0.2)',
                  border: '1px solid rgba(239,68,68,0.4)',
                  borderRadius: '50%',
                  width: 20,
                  height: 20,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'white',
                  cursor: 'pointer',
                  marginLeft: 4,
                }}
                title="Reset Flow Trace"
              >
                <X size={10} />
              </button>
            </div>
          </div>
        )}

        {neighborhoodNodeId && (
          <div
            style={{
              position: 'absolute',
              top: activeTraceStartId ? 75 : 20,
              left: 20,
              zIndex: 5,
              background: 'rgba(59, 130, 246, 0.15)',
              border: '1px solid #3b82f6',
              borderRadius: '24px',
              padding: '6px 14px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              color: '#93c5fd',
              backdropFilter: 'blur(10px)',
            }}
          >
            <span>Neighborhood isolation view active</span>
            <button
              onClick={() => setNeighborhoodNodeId(null)}
              style={{
                background: 'rgba(255,255,255,0.1)',
                border: 'none',
                borderRadius: '50%',
                width: 18,
                height: 18,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'white',
                cursor: 'pointer',
              }}
            >
              <X size={10} />
            </button>
          </div>
        )}

        <ForceGraphCanvas
          graph={currentGraph}
          searchTerm={searchTerm}
          selectedKinds={selectedKinds}
          selectedEdgeKinds={selectedEdgeKinds}
          neighborhoodNodeId={neighborhoodNodeId}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
          focusRequest={focusRequest}
        />
      </main>

      {/* RIGHT SIDEBAR: Symbol Details / Inspector */}
      <aside className="sidebar right">
        {selectedSymbol ? (
          <>
            <div className="sidebar-header">
              <div className="inspector-title-area">
                <div
                  className="inspector-kind-badge"
                  style={{ backgroundColor: getSymbolTheme(selectedSymbol.kind).color }}
                >
                  {selectedSymbol.kind}
                </div>
                <button
                  onClick={() => setSelectedNodeId(null)}
                  style={{
                    marginLeft: 'auto',
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                  }}
                >
                  <X size={16} />
                </button>
              </div>
              <div className="inspector-name">{selectedSymbol.name}</div>
              <div className="inspector-qname">{selectedSymbol.qualifiedName}</div>
            </div>

            <div className="sidebar-content">
              {/* Properties Panel */}
              <div className="section-card">
                <div className="section-title">
                  <span>Symbol Details</span>
                  <Info size={14} color="var(--text-muted)" />
                </div>
                <div className="inspector-meta-row">
                  <span className="inspector-meta-label">File Location</span>
                  <span className="inspector-meta-val" title={selectedSymbol.filePath}>{selectedSymbol.filePath}</span>
                </div>
                <div className="inspector-meta-row">
                  <span className="inspector-meta-label">Visibility</span>
                  <span className="inspector-meta-val" style={{ textTransform: 'capitalize' }}>
                    {selectedSymbol.visibility}
                  </span>
                </div>
                <div className="inspector-meta-row">
                  <span className="inspector-meta-label">Exported</span>
                  <span className="inspector-meta-val">{selectedSymbol.exported ? 'Yes' : 'No'}</span>
                </div>
                <div className="inspector-meta-row">
                  <span className="inspector-meta-label">Source Range</span>
                  <span className="inspector-meta-val" style={{ fontFamily: 'monospace' }}>
                    L{selectedSymbol.range.start.line + 1}:{selectedSymbol.range.start.column} - L
                    {selectedSymbol.range.end.line + 1}:{selectedSymbol.range.end.column}
                  </span>
                </div>
                
                {/* Extensible metadata properties list */}
                {Object.entries(selectedSymbol.metadata || {}).map(([key, val]) => {
                  if (typeof val === 'object') return null;
                  return (
                    <div className="inspector-meta-row" key={key}>
                      <span className="inspector-meta-label" style={{ textTransform: 'capitalize' }}>{key}</span>
                      <span className="inspector-meta-val">{String(val)}</span>
                    </div>
                  );
                })}
              </div>

              {/* Actions panel */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="action-btn" onClick={() => selectAndFocusNode(selectedSymbol.id)}>
                    <Focus size={16} />
                    Focus in Graph
                  </button>
                  <button
                    className={`action-btn secondary ${neighborhoodNodeId === selectedSymbol.id ? 'active' : ''}`}
                    onClick={() =>
                      setNeighborhoodNodeId(neighborhoodNodeId === selectedSymbol.id ? null : selectedSymbol.id)
                    }
                    style={{
                      borderColor: neighborhoodNodeId === selectedSymbol.id ? '#3b82f6' : 'var(--border-color)',
                    }}
                  >
                    <BookOpen size={16} />
                    Neighborhood
                  </button>
                </div>
                
                {selectedSymbol && (
                  <button
                    className="action-btn"
                    onClick={() => {
                      if (activeTraceStartId === selectedSymbol.id) {
                        setActiveTraceStartId(null);
                      } else {
                        setActiveTraceStartId(selectedSymbol.id);
                        setTraceDepth(4);
                      }
                    }}
                    style={{
                      backgroundColor: activeTraceStartId === selectedSymbol.id ? '#ef4444' : '#10b981',
                      color: 'white',
                    }}
                  >
                    <Activity size={16} />
                    {activeTraceStartId === selectedSymbol.id ? 'Stop Flow Trace' : 'Trace Execution Flow'}
                  </button>
                )}
              </div>

              {/* References Panel: Callers & Importers */}
              {selectedRelations && (
                <>
                  <div className="section-card">
                    <div className="section-title">
                      <span>Incoming Relations ({selectedRelations.referencesReceived.length})</span>
                      <ArrowRightLeft size={14} color="var(--text-muted)" />
                    </div>
                    {selectedRelations.referencesReceived.length > 0 ? (
                      <div className="inspector-relations-list">
                        {selectedRelations.referencesReceived.map(({ ref, sourceSymbol }) => (
                          <div
                            key={ref.candidateId}
                            className="inspector-relation-card"
                            onClick={() => selectAndFocusNode(sourceSymbol.id)}
                          >
                            <span className="relation-name">{sourceSymbol.name}</span>
                            <span className="relation-meta">{ref.kind}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 8 }}>
                        No incoming references resolved.
                      </div>
                    )}
                  </div>

                  <div className="section-card">
                    <div className="section-title">
                      <span>Outgoing Relations ({selectedRelations.referencesMade.length})</span>
                      <ArrowRightLeft size={14} color="var(--text-muted)" />
                    </div>
                    {selectedRelations.referencesMade.length > 0 ? (
                      <div className="inspector-relations-list">
                        {selectedRelations.referencesMade.map(({ ref, targetSymbol }) => (
                          <div
                            key={ref.candidateId}
                            className="inspector-relation-card"
                            onClick={() => selectAndFocusNode(targetSymbol.id)}
                          >
                            <span className="relation-name">{targetSymbol.name}</span>
                            <span className="relation-meta">{ref.kind}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 8 }}>
                        No outgoing references made.
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Collapsible legend at the bottom of detail panel */}
              <LegendSection />
            </div>
          </>
        ) : (
          <div className="inspector-empty" style={{ justifyContent: 'flex-start', padding: '40px 24px' }}>
            <Info size={36} color="var(--text-muted)" style={{ margin: '0 auto 16px auto' }} />
            <div>
              <h3 style={{ margin: '0 0 8px 0', fontSize: 16, fontFamily: 'var(--font-title)' }}>Symbol Inspector</h3>
              <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: 0 }}>
                Click a node on the canvas, or search for symbols, to inspect detailed code structure and relations.
              </p>
            </div>
            <LegendSection />
          </div>
        )}
      </aside>
    </div>
  );
}

export default function App() {
  return <VisualizerDashboard />;
}
