'use client';

import { useEffect, useState } from 'react';
import VerdictBadge from '@/components/VerdictBadge';
import styles from './inventory.module.css';
import { useToast } from '@/components/ToastContext';
import type { BadgeVerdict } from '@/lib/verdictCopy';

type FilterType = 'All' | 'Active' | 'Flagged' | 'Recalled';

type ProductStatus = 'active' | 'flagged' | 'recalled';

/** The shape /api/products returns — a view model, not the raw Product row. */
interface InventoryProduct {
  id: string;
  name: string | null;
  brand: string | null;
  barcode: string | null;
  /** Scan count, used as a proxy for market presence. */
  stock: number;
  verdict: BadgeVerdict;
  status: ProductStatus;
  reference_batch_pattern: string | null;
  reference_image_url: string | null;
}

const FILTERS: FilterType[] = ['All', 'Active', 'Flagged', 'Recalled'];
const PAGE_SIZE = 6;

/**
 * Verdict → theme token. Colour used to arrive from /api/products as literal
 * light-theme hex, which meant the cards stayed light on the dark canvas and
 * the palette could only be changed by editing an API route. The endpoint now
 * sends just the verdict and the mapping lives here, in the presentation layer.
 */
const VERDICT_ACCENT: Partial<Record<BadgeVerdict, string>> = {
  genuine: 'var(--verdict-genuine)',
  suspicious: 'var(--verdict-suspicious)',
  counterfeit: 'var(--verdict-counterfeit)',
  unverified: 'var(--text-muted)',
};

const accentFor = (verdict: BadgeVerdict) =>
  VERDICT_ACCENT[verdict] ?? VERDICT_ACCENT.unverified!;

/** Translucent variant of an accent, theme-aware (replaces hex alpha suffixes). */
const tint = (color: string, pct: number) =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

function filterProducts(products: InventoryProduct[], filter: FilterType, search: string) {
  let result = products;
  if (filter === 'Active') result = result.filter(p => p.status === 'active');
  if (filter === 'Flagged') result = result.filter(p => p.status === 'flagged');
  if (filter === 'Recalled') result = result.filter(p => p.status === 'recalled');
  
  if (search) {
    const q = search.toLowerCase();
    // Null-safe: a product row with no name or brand used to throw here the
    // moment anyone typed in the search box.
    result = result.filter(p =>
      (p.name ?? '').toLowerCase().includes(q) ||
      (p.brand ?? '').toLowerCase().includes(q) ||
      (p.barcode ?? '').toLowerCase().includes(q)
    );
  }
  return result;
}

export default function InventoryPage() {
  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [filter, setFilter] = useState<FilterType>('All');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form states
  const [newName, setNewName] = useState('');
  const [newBrand, setNewBrand] = useState('');
  const [newBarcode, setNewBarcode] = useState('');
  const [newImageUrl, setNewImageUrl] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { showToast } = useToast();

  /** Fetch without touching state, so callers decide when to commit. */
  async function fetchProducts(): Promise<{ data?: InventoryProduct[]; error?: string }> {
    try {
      const res = await fetch("/api/products");
      if (!res.ok) throw new Error("Failed to load inventory from server");
      return { data: (await res.json()) as InventoryProduct[] };
    } catch (err) {
      console.error(err);
      return { error: err instanceof Error ? err.message : "Failed to load products" };
    }
  }

  function apply(res: { data?: InventoryProduct[]; error?: string }) {
    setLoading(false);
    if (res.error) setError(res.error);
    else if (res.data) { setError(null); setProducts(res.data); }
  }

  /** Called from event handlers (add / status change), where sync state is fine. */
  async function loadProducts() {
    setLoading(true);
    setError(null);
    apply(await fetchProducts());
  }

  // `loading` starts true, so the first setState lands after the await rather
  // than synchronously inside the effect body.
  useEffect(() => {
    let cancelled = false;
    fetchProducts().then((res) => {
      if (!cancelled) apply(res);
    });
    return () => { cancelled = true; };
  }, []);

  async function handleStatusChange(productId: string, newStatus: 'active' | 'flagged' | 'recalled') {
    try {
      const res = await fetch("/api/products", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: productId, status: newStatus })
      });
      if (!res.ok) throw new Error("Failed to update status");
      
      // Optimistic UI update
      setProducts(prev => prev.map(p => {
        if (p.id === productId) {
          let displayVerdict: BadgeVerdict = "genuine";
          if (newStatus === "flagged") displayVerdict = "suspicious";
          else if (newStatus === "recalled") displayVerdict = "counterfeit";
          else if (p.stock === 0) displayVerdict = "unverified";

          // Only the verdict is stored; colour is derived at render time from
          // the theme tokens, so it stays correct in both themes.
          return { ...p, status: newStatus, verdict: displayVerdict };
        }
        return p;
      }));
    } catch (err) {
      console.error(err);
      showToast("Failed to update product status. Please try again.", 'error');
    }
  }

  async function handleAddProduct(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!newName.trim() || !newBrand.trim() || !newBarcode.trim()) {
      setFormError("Product Name, Brand, and Barcode are all required.");
      return;
    }

    if (!/^[0-9]+$/.test(newBarcode.trim())) {
      setFormError("Barcode must consist of digits only (EAN/UPC format).");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          brand: newBrand,
          barcode: newBarcode,
          reference_image: newImageUrl || null
        })
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to add product");

      setNewName('');
      setNewBrand('');
      setNewBarcode('');
      setNewImageUrl('');
      setShowAdd(false);
      loadProducts();
    } catch (err) {
      console.error(err);
      setFormError(err instanceof Error ? err.message : "Failed to add product");
    } finally {
      setSubmitting(false);
    }
  }

  const filtered = filterProducts(products, filter, search);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Inventory Management</h1>
          <p className={styles.subtitle}>{filtered.length} products tracked across all regions</p>
        </div>
        <button className={styles.addBtn} onClick={() => setShowAdd(true)}>
          <span className="material-symbols-outlined">add</span>
          Add Product
        </button>
      </div>

      {/* Search + Filters */}
      <div className={styles.controls}>
        <div className={styles.searchWrap}>
          <span className={`material-symbols-outlined ${styles.searchIcon}`}>search</span>
          <input
            className={styles.searchInput}
            placeholder="Search products, brands, barcodes…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
          />
          {search && (
            <button className={styles.clearSearch} onClick={() => setSearch('')}>
              <span className="material-symbols-outlined">close</span>
            </button>
          )}
        </div>
        <div className={styles.chips}>
          {FILTERS.map(f => (
            <button
              key={f}
              className={`${styles.chip} ${filter === f ? styles.chipActive : ''}`}
              onClick={() => { setFilter(f); setPage(1); }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Product Grid */}
      {loading ? (
        <div style={{ padding: '60px', textAlign: 'center', color: 'var(--color-on-surface-variant)' }}>
          <span className="material-symbols-outlined spin" style={{ fontSize: '32px' }}>sync</span>
          <p style={{ marginTop: '8px' }}>Loading inventory items...</p>
        </div>
      ) : error ? (
        <div style={{ padding: '40px', textAlign: 'center', color: 'var(--color-error)' }}>
          <span className="material-symbols-outlined" style={{ fontSize: '40px' }}>error</span>
          <p style={{ marginTop: '8px' }}>{error}</p>
          <button className={styles.addBtn} style={{ marginTop: '12px', background: 'var(--bg-glass-hover)' }} onClick={loadProducts}>Retry</button>
        </div>
      ) : paginated.length === 0 ? (
        <div className={styles.empty}>
          <span className="material-symbols-outlined" style={{ fontSize: '48px', opacity: 0.3 }}>inventory_2</span>
          <p>No products found</p>
        </div>
      ) : (
        <div className={styles.grid}>
          {paginated.map(p => {
            const accent = accentFor(p.verdict);
            return (
            <div key={p.id} className={styles.card}>
              <div className={styles.cardImage} style={{ background: tint(accent, 10), borderColor: tint(accent, 25) }}>
                <span className="material-symbols-outlined" style={{ color: accent, fontSize: '36px' }}>
                  {p.status === 'recalled' ? 'cancel' : 'medication'}
                </span>
              </div>
              <div className={styles.cardBody}>
                <div className={styles.cardTop}>
                  <h3 className={styles.productName}>{p.name}</h3>
                  <span className={styles.brandTag}>{p.brand}</span>
                  <p style={{ fontSize: '11px', color: 'var(--color-on-surface-variant)', marginTop: '4px', fontFamily: 'monospace' }}>
                    SKU: {p.barcode}
                  </p>
                </div>
                <div className={styles.cardFooter}>
                  <div className={styles.stockInfo}>
                    <span className={styles.stockLabel}>Scans Count</span>
                    <span className={styles.stockValue}>
                      {p.stock.toLocaleString()}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}>
                    <VerdictBadge verdict={p.verdict} size="sm" />
                    <select
                      value={p.status}
                      onChange={(e) => handleStatusChange(p.id, e.target.value as ProductStatus)}
                      style={{
                        background: 'var(--bg-surface)',
                        border: '1px solid var(--border-interactive)',
                        color: 'var(--text-primary)',
                        padding: '3px 6px',
                        borderRadius: '6px',
                        fontSize: '11px',
                        outline: 'none',
                        cursor: 'pointer'
                      }}
                    >
                      {/* No inline colours: these pinned a white dropdown with
                          dark ink, a light-mode island inside the dark console.
                          The native menu follows the `color-scheme` declared on
                          :root, so leaving it alone is what makes it themed. */}
                      <option value="active">Active</option>
                      <option value="flagged">Flagged</option>
                      <option value="recalled">Recalled</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className={styles.pagination}>
          <button
            className={styles.pageBtn}
            disabled={page === 1}
            onClick={() => setPage(p => p - 1)}
          >
            <span className="material-symbols-outlined">chevron_left</span>
            Prev
          </button>
          <div className={styles.pageDots}>
            {Array.from({ length: totalPages }).map((_, i) => (
              <button
                key={i}
                className={`${styles.pageDot} ${page === i + 1 ? styles.pageDotActive : ''}`}
                onClick={() => setPage(i + 1)}
              />
            ))}
          </div>
          <button
            className={styles.pageBtn}
            disabled={page === totalPages}
            onClick={() => setPage(p => p + 1)}
          >
            Next
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
        </div>
      )}

      {/* Add Product Modal */}
      {showAdd && (
        <div className={styles.modalOverlay} onClick={() => setShowAdd(false)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <form onSubmit={handleAddProduct}>
              <div className={styles.modalHeader}>
                <h2 className={styles.modalTitle}>Add Reference Product</h2>
                <button type="button" className={styles.modalClose} onClick={() => setShowAdd(false)}>
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              <div className={styles.modalBody}>
                {formError && (
                  <p style={{ color: 'var(--color-error)', fontSize: '13px', marginBottom: '16px' }}>{formError}</p>
                )}
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Product Name *</label>
                  <input
                    required
                    className={styles.formInput}
                    placeholder="Enter product name (e.g. Lifebuoy Soap)..."
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Brand *</label>
                  <input
                    required
                    className={styles.formInput}
                    placeholder="Enter brand owner (e.g. Unilever Pakistan)..."
                    value={newBrand}
                    onChange={e => setNewBrand(e.target.value)}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Barcode / SKU *</label>
                  <input
                    required
                    className={styles.formInput}
                    placeholder="Enter unique digits barcode..."
                    value={newBarcode}
                    onChange={e => setNewBarcode(e.target.value)}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Reference Image URL (Optional)</label>
                  <input
                    className={styles.formInput}
                    placeholder="Enter reference image public URL..."
                    value={newImageUrl}
                    onChange={e => setNewImageUrl(e.target.value)}
                  />
                </div>
              </div>
              <div className={styles.modalFooter}>
                <button type="button" className={styles.btnOutlined} onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className={styles.btnPrimary} disabled={submitting}>
                  {submitting ? 'Registering...' : 'Register Product'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
