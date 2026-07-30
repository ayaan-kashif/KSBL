'use client';

import { useEffect, useState } from 'react';
import VerdictBadge from '@/components/VerdictBadge';
import styles from './inventory.module.css';
import { useToast } from '@/components/ToastContext';

type FilterType = 'All' | 'Active' | 'Flagged' | 'Recalled';

const FILTERS: FilterType[] = ['All', 'Active', 'Flagged', 'Recalled'];
const PAGE_SIZE = 6;

function filterProducts(products: any[], filter: FilterType, search: string) {
  let result = products;
  if (filter === 'Active') result = result.filter(p => p.status === 'active');
  if (filter === 'Flagged') result = result.filter(p => p.status === 'flagged');
  if (filter === 'Recalled') result = result.filter(p => p.status === 'recalled');
  
  if (search) {
    const q = search.toLowerCase();
    result = result.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.brand.toLowerCase().includes(q) ||
      (p.barcode && p.barcode.toLowerCase().includes(q))
    );
  }
  return result;
}

export default function InventoryPage() {
  const [products, setProducts] = useState<any[]>([]);
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

  async function loadProducts() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/products");
      if (!res.ok) throw new Error("Failed to load inventory from server");
      const data = await res.json();
      setProducts(data);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to load products");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProducts();
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
          let displayVerdict = "genuine";
          if (newStatus === "flagged") displayVerdict = "suspicious";
          else if (newStatus === "recalled") displayVerdict = "counterfeit";
          else if (p.stock === 0) displayVerdict = "unverified";

          let color = "var(--verdict-genuine-soft)";
          let accent = "var(--verdict-genuine)";
          if (displayVerdict === "suspicious") {
            color = "var(--verdict-suspicious-soft)";
            accent = "var(--verdict-suspicious)";
          } else if (displayVerdict === "counterfeit") {
            color = "var(--verdict-counterfeit-soft)";
            accent = "var(--verdict-counterfeit)";
          } else if (displayVerdict === "unverified") {
            color = "var(--glass-2)";
            accent = "var(--text-secondary)";
          }

          return { ...p, status: newStatus, verdict: displayVerdict, color, accent };
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
          <button className={styles.addBtn} style={{ marginTop: '12px', background: 'rgba(255,255,255,0.08)' }} onClick={loadProducts}>Retry</button>
        </div>
      ) : paginated.length === 0 ? (
        <div className={styles.empty}>
          <span className="material-symbols-outlined" style={{ fontSize: '48px', opacity: 0.3 }}>inventory_2</span>
          <p>No products found</p>
        </div>
      ) : (
        <div className={styles.grid}>
          {paginated.map(p => (
            <div key={p.id} className={styles.card}>
              {/* color-mix, not hex-alpha concatenation: p.accent is a var()
                  reference, so appending "40" would be invalid CSS. */}
              <div
                className={styles.cardImage}
                style={{ background: p.color, borderColor: `color-mix(in srgb, ${p.accent} 40%, transparent)` }}
              >
                <span className="material-symbols-outlined" style={{ color: p.accent, fontSize: '36px' }}>
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
                      onChange={(e) => handleStatusChange(p.id, e.target.value as any)}
                      style={{
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        color: 'rgba(255,255,255,0.8)',
                        padding: '3px 6px',
                        borderRadius: '6px',
                        fontSize: '11px',
                        outline: 'none',
                        cursor: 'pointer'
                      }}
                    >
                      <option value="active" style={{ background: '#1c1b1f', color: 'white' }}>Active</option>
                      <option value="flagged" style={{ background: '#1c1b1f', color: 'white' }}>Flagged</option>
                      <option value="recalled" style={{ background: '#1c1b1f', color: 'white' }}>Recalled</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          ))}
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
