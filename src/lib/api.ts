/**
 * src/lib/api.ts
 *
 * Typed client for all ShelfWatch API endpoints.
 * All API calls go through these helpers — no raw fetch() scattered in components.
 *
 * Design rules:
 *  - Always returns { data } or { error } — never throws to the caller.
 *  - Every function is typed end-to-end so TypeScript catches contract mismatches.
 *  - No API keys client-side — everything routes through Next.js API routes.
 */

// ─── Shared types (mirror API contract exactly) ───────────────────────────────

export type VerdictType = 'genuine' | 'suspicious' | 'unverified';
export type ScannedByRole = 'shopkeeper' | 'consumer';

export interface ScanResult {
  scan_id: string;
  verdict: VerdictType;
  confidence: number;       // 0–1
  reason: string;           // English (alias of reason_en, kept for compatibility)
  reason_ur?: string;       // Urdu counterpart of `reason`
  english_text: string;
  urdu_text: string;
  product_name: string | null;
  brand_name: string | null;
  extracted_batch: string | null;
  extracted_mfg_date: string | null;
  extracted_mrp: string | null;
  cv_anomaly_score: number | null;
  /** Barcode check line. Optional so a result cached before it existed still renders. */
  barcode_check?: BarcodeCheckLine;
  /** Medicine scans only — see services/medicineChecks.ts. */
  medicine?: MedicineResult | null;
}

/** One medicine check (CheckResult in services/medicineChecks.ts), in both languages. */
export interface MedicineCheckLine {
  id: string;
  status: 'pass' | 'fail' | 'warn' | 'skipped';
  severity: 'critical' | 'high' | 'medium' | 'low';
  reasonEn: string;
  reasonUr: string;
}

/** The medicine part of a scan payload (both /api/verify and /api/scan). */
export interface MedicineResult {
  verdict?: { status: 'no_problems' | 'suspicious' | 'counterfeit' | 'expired' | 'unverified'; expired: boolean; score: number };
  checks: MedicineCheckLine[];
  /** A GS1 2D code was decoded (older stock has none). */
  has2dCode?: boolean;
  /** DRAP alert behind a flagged batch / product, if any. */
  drapAlert?: { product_name: string; batch_no: string; alert_type: string; alert_date: string; source_url: string; exactBatch: boolean } | null;
  printed: {
    brandName: string | null; genericName: string | null; strength: string | null; dosageForm: string | null;
    packSize: string | null; manufacturer: string | null; drapRegNo: string | null; batch: string | null;
    mfgDate: string | null; expiryDate: string | null; mrp: string | null;
  } | null;
  gs1: { gtin: string | null; batch: string | null; mfgDate: string | null; expiry: string | null; serial: string | null } | null;
  expiry: { date: string | null; source: string | null; expired: boolean };
  identity: {
    product: {
      product_name: string; generic_name: string | null; strength: string | null; dosage_form: string | null;
      manufacturer: string | null; drap_reg_no: string | null;
    } | null;
  };
  registration: { regNo: string | null; status: string; record: { brand_name: string; company: string | null } | null };
  registrationMismatch: boolean;
  sourcesConsulted: string[];
}

/** One-line barcode result shown beside the verdict reason (both endpoints). */
export interface BarcodeCheckLine {
  status: 'verified' | 'mismatch' | 'tampered' | 'unconfirmed' | 'not_visible';
  source: 'decoded' | 'ai_read' | 'manual' | null;
  format: string | null;
  value: string | null;
  en: string;
  ur: string;
}

export interface ReportResult {
  report_id: string;
  scan_id: string;
  status: string;
  already_reported?: boolean;
}

export interface DashboardStats {
  total_scans: number;
  genuine_count: number;
  suspicious_count: number;
  unverified_count: number;
  suspicious_rate: number;          // percentage, e.g. 40.00
  estimated_losses_pkr: number;
  date_range: { from: string; to: string };
}

export interface HeatmapCluster {
  area_name: string;
  latitude: number | null;
  longitude: number | null;
  report_count: number;
  suspicious_count: number;
  suspicious_rate: number;
}

export interface ScanAiFlags {
  logoMatch: number;
  packagingMatch: number;
  barcodeMatch: number;
  brandMatch: number;
  designMatch: number;
  tampering: boolean;
  reason: string;
}

export interface ScanHistoryItem {
  id: string;
  verdict: VerdictType;
  confidence: number;
  area_name: string | null;
  product_name: string | null;
  brand_name: string | null;
  category: string | null;
  barcode: string | null;
  extracted_batch: string | null;
  image_url: string;
  created_at: string;
  ai_flags: ScanAiFlags | null;
  /** Medicine scans only (from /api/scans/mine). */
  expiry_date?: string | null;
}

// ─── Result wrapper ───────────────────────────────────────────────────────────

type ApiResult<T> =
  | { data: T; error: null }
  | { data: null; error: string };

function ok<T>(data: T): ApiResult<T> {
  return { data, error: null };
}
function err<T>(message: string): ApiResult<T> {
  return { data: null, error: message };
}

// ─── POST /api/scan ───────────────────────────────────────────────────────────

export interface ScanInput {
  imageFile: File;
  barcode?: string;
  role?: ScannedByRole;
  latitude?: number;
  longitude?: number;
  area_name?: string;
}

export async function postScan(input: ScanInput): Promise<ApiResult<ScanResult>> {
  try {
    const form = new FormData();
    form.append('image', input.imageFile);
    if (input.barcode) form.append('barcode', input.barcode);
    form.append('scanned_by_role', input.role ?? 'consumer');
    if (input.latitude != null) form.append('latitude', String(input.latitude));
    if (input.longitude != null) form.append('longitude', String(input.longitude));
    if (input.area_name) form.append('area_name', input.area_name);

    const res = await fetch('/api/scan', { method: 'POST', body: form });
    const json = await res.json();
    if (!res.ok) return err(json.error ?? `Scan failed (${res.status})`);
    return ok(json as ScanResult);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error — check your connection');
  }
}

// ─── Customer auth (/api/auth/*) ───────────────────────────────────────────────

export interface CustomerProfile {
  id: string;
  name: string;
  email: string;
  score_points: number;
}

export async function postSignup(input: {
  name: string;
  email: string;
  password: string;
}): Promise<ApiResult<CustomerProfile>> {
  try {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const json = await res.json();
    if (!res.ok) return err(json.error ?? `Signup failed (${res.status})`);
    return ok(json as CustomerProfile);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error — check your connection');
  }
}

export async function postLogin(input: {
  email: string;
  password: string;
}): Promise<ApiResult<CustomerProfile>> {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const json = await res.json();
    if (!res.ok) return err(json.error ?? `Login failed (${res.status})`);
    return ok(json as CustomerProfile);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error — check your connection');
  }
}

/** Step one of "Forgot password?" — see src/app/api/auth/forgot-password/route.ts. */
export async function postForgotPassword(email: string): Promise<ApiResult<{ ok: true }>> {
  try {
    const res = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const json = await res.json();
    if (!res.ok) return err(json.error ?? `Request failed (${res.status})`);
    return ok({ ok: true });
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error — check your connection');
  }
}

/** Saves the new password for email/password login, authorized by the recovery session's access token. */
export async function postResetPassword(accessToken: string, password: string): Promise<ApiResult<{ ok: true }>> {
  try {
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ password }),
    });
    const json = await res.json();
    if (!res.ok) return err(json.error ?? `Request failed (${res.status})`);
    return ok({ ok: true });
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error — check your connection');
  }
}

export async function postLogout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    // best-effort
  }
}

export async function getMe(): Promise<ApiResult<CustomerProfile>> {
  try {
    const res = await fetch('/api/auth/me');
    const json = await res.json();
    if (!res.ok || !json.authenticated) return err('Not authenticated');
    return ok(json as CustomerProfile);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error — check your connection');
  }
}

// ─── GET /api/scans/mine ────────────────────────────────────────────────────────

export async function getMyScanHistory(limit = 20): Promise<ApiResult<ScanHistoryItem[]>> {
  try {
    const res = await fetch(`/api/scans/mine?limit=${limit}`);
    const json = await res.json();
    if (!res.ok) return err(json.error ?? `Failed to load scan history (${res.status})`);
    return ok(json as ScanHistoryItem[]);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error — check your connection');
  }
}

// ─── GET /api/leaderboard (admin-only) ─────────────────────────────────────────

export interface LeaderboardEntry {
  id: string;
  name: string;
  email: string;
  score_points: number;
}

export async function getLeaderboard(): Promise<ApiResult<LeaderboardEntry[]>> {
  try {
    const res = await fetch('/api/leaderboard');
    const json = await res.json();
    if (!res.ok) return err(json.error ?? `Failed to load leaderboard (${res.status})`);
    return ok(json as LeaderboardEntry[]);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error — check your connection');
  }
}

// ─── GET /api/brands ──────────────────────────────────────────────────────────

export interface BrandOption {
  id: string;
  name: string;
}

export async function getBrands(): Promise<ApiResult<BrandOption[]>> {
  try {
    const res = await fetch('/api/brands');
    const json = await res.json();
    if (!res.ok) return err(json.error ?? `Failed to load brands (${res.status})`);
    return ok(json as BrandOption[]);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error — check your connection');
  }
}

// ─── GET /api/stats/public ────────────────────────────────────────────────────

export interface PublicStats {
  total_scans: number;
  suspicious_count: number;
  /** Share of scans that reached a confident verdict — NOT model accuracy. */
  resolved_rate: number;
}

export async function getPublicStats(): Promise<ApiResult<PublicStats>> {
  try {
    const res = await fetch('/api/stats/public');
    const json = await res.json();
    if (!res.ok) return err(json.error ?? `Failed to load stats (${res.status})`);
    return ok(json as PublicStats);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error — check your connection');
  }
}

// ─── POST /api/report ─────────────────────────────────────────────────────────

export async function postReport(
  scanId: string,
  notes?: string
): Promise<ApiResult<ReportResult>> {
  try {
    const res = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scan_id: scanId, notes: notes ?? null }),
    });
    const json = await res.json();
    // 409 = already reported — treat as success for the UI
    if (res.status === 409) return ok(json as ReportResult);
    if (!res.ok) return err(json.error ?? `Report failed (${res.status})`);
    return ok(json as ReportResult);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error');
  }
}

// ─── GET /api/dashboard/stats ─────────────────────────────────────────────────

export async function getDashboardStats(
  brandId: string,
  from?: string,
  to?: string
): Promise<ApiResult<DashboardStats>> {
  try {
    const params = new URLSearchParams({ brand_id: brandId });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const res = await fetch(`/api/dashboard/stats?${params}`);
    const json = await res.json();
    if (!res.ok) return err(json.error ?? 'Failed to load stats');
    return ok(json as DashboardStats);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error');
  }
}

// ─── GET /api/dashboard/heatmap ──────────────────────────────────────────────

export async function getDashboardHeatmap(
  brandId: string
): Promise<ApiResult<HeatmapCluster[]>> {
  try {
    const res = await fetch(`/api/dashboard/heatmap?brand_id=${brandId}`);
    const json = await res.json();
    if (!res.ok) return err(json.error ?? 'Failed to load heatmap');
    return ok(json as HeatmapCluster[]);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error');
  }
}

// ─── GET /api/scans (scan history) ───────────────────────────────────────────

export async function getScanHistory(limit = 20): Promise<ApiResult<ScanHistoryItem[]>> {
  try {
    const res = await fetch(`/api/scans?limit=${limit}`);
    const json = await res.json();
    if (!res.ok) return err(json.error ?? 'Failed to load scan history');
    return ok(json as ScanHistoryItem[]);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error');
  }
}

// ─── HORECA rewards / vouchers ────────────────────────────────────────────────

export type VoucherStatus = 'issued' | 'redeemed' | 'expired';

export interface RewardPartner {
  id: string;
  name: string;
  cuisine: string;
  area: string;
  logo_url: string | null;
}

export interface RewardOffer {
  id: string;
  title_en: string;
  title_ur: string;
  description_en: string;
  description_ur: string;
  points_cost: number;
  consumer_value_pkr: number;
  bulk_credit_pkr: number;
  partner: RewardPartner | null;
}

export interface Voucher {
  id: string;
  code: string;
  status: VoucherStatus;
  issued_at: string;
  expires_at: string;
  redeemed_at: string | null;
  offer: (Omit<RewardOffer, 'bulk_credit_pkr'> & { partner: RewardPartner | null }) | null;
}

export interface RedeemResult {
  voucher: { id: string; code: string; expires_at: string; status: VoucherStatus };
  offer: {
    id: string;
    title_en: string;
    consumer_value_pkr: number;
    points_cost: number;
    partner_name: string | null;
  };
  balance: number;
}

/** A 400 from /api/rewards/redeem carries the shortfall so the catalog can say
 *  "240 more points" rather than a bare failure. */
export interface RedeemShortfall {
  shortfall: number;
  points_cost: number;
  balance: number;
}

export type PartnerRedeemResult = 'valid' | 'not_found' | 'already_redeemed' | 'expired';

export interface PartnerRedeemResponse {
  result: PartnerRedeemResult;
  code: string;
  redeemed_at?: string | null;
  expires_at?: string;
  offer_title?: string | null;
  offer_title_ur?: string | null;
  consumer_value_pkr?: number | null;
  bulk_credit_pkr?: number;
  partner_name?: string | null;
  partner_area?: string | null;
}

export interface PartnerStats {
  vouchers_redeemed: number;
  consumer_value_pkr: number;
  bulk_credit_pkr: number;
  top_partners: {
    partner_id: string;
    name: string;
    area: string;
    redemptions: number;
    bulk_credit_pkr: number;
  }[];
}

export async function getRewards(): Promise<ApiResult<RewardOffer[]>> {
  try {
    const res = await fetch('/api/rewards');
    const json = await res.json();
    if (!res.ok) return err(json.error ?? `Failed to load rewards (${res.status})`);
    return ok(json as RewardOffer[]);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error — check your connection');
  }
}

type RedeemApiResult =
  | { data: RedeemResult; error: null; shortfall?: undefined }
  | { data: null; error: string; shortfall?: RedeemShortfall };

export async function postRedeemReward(offerId: string): Promise<RedeemApiResult> {
  try {
    const res = await fetch('/api/rewards/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offer_id: offerId }),
    });
    const json = await res.json();
    if (!res.ok) {
      const message: string = json.error ?? `Redemption failed (${res.status})`;
      // Insufficient points is a normal outcome, not a fault — pass the numbers
      // through so the UI can show the gap instead of just the message.
      if (typeof json.shortfall === 'number') {
        return {
          data: null,
          error: message,
          shortfall: { shortfall: json.shortfall, points_cost: json.points_cost, balance: json.balance },
        };
      }
      return { data: null, error: message };
    }
    return { data: json as RedeemResult, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : 'Network error — check your connection' };
  }
}

export async function getMyVouchers(): Promise<ApiResult<Voucher[]>> {
  try {
    const res = await fetch('/api/vouchers/mine');
    const json = await res.json();
    if (!res.ok) return err(json.error ?? `Failed to load vouchers (${res.status})`);
    return ok(json as Voucher[]);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error — check your connection');
  }
}

export async function postPartnerRedeem(code: string): Promise<ApiResult<PartnerRedeemResponse>> {
  try {
    const res = await fetch('/api/partner/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const json = await res.json();
    if (!res.ok) return err(json.error ?? `Redemption failed (${res.status})`);
    return ok(json as PartnerRedeemResponse);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error — check your connection');
  }
}

export async function getPartnerStats(): Promise<ApiResult<PartnerStats>> {
  try {
    const res = await fetch('/api/partners/stats');
    const json = await res.json();
    if (!res.ok) return err(json.error ?? `Failed to load partner stats (${res.status})`);
    return ok(json as PartnerStats);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Network error — check your connection');
  }
}

/** Whole days until expiry; negative once lapsed. */
export function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

// ─── sessionStorage helpers ───────────────────────────────────────────────────

const SCAN_KEY = 'shelfwatch_scan_result';

export function storeScanResult(result: ScanResult): void {
  try {
    sessionStorage.setItem(SCAN_KEY, JSON.stringify(result));
  } catch {
    /* ignore QuotaExceededError */
  }
}

export function readScanResult(): ScanResult | null {
  try {
    const raw = sessionStorage.getItem(SCAN_KEY);
    return raw ? (JSON.parse(raw) as ScanResult) : null;
  } catch {
    return null;
  }
}

// ─── Geolocation helper ───────────────────────────────────────────────────────

type GeoAttempt =
  | { ok: true; latitude: number; longitude: number }
  | { ok: false; deniedPermission: boolean };

function getPosition(options: PositionOptions): Promise<GeoAttempt> {
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ ok: true, latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      (err) => resolve({ ok: false, deniedPermission: err.code === err.PERMISSION_DENIED }),
      options
    );
  });
}

export async function getGeolocation(): Promise<{
  latitude: number;
  longitude: number;
} | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return null;
  }

  // First attempt: GPS-priority, short timeout — best accuracy, but many
  // laptops/desktops have no GPS chip and will time out here.
  const first = await getPosition({ timeout: 6000, maximumAge: 60000, enableHighAccuracy: true });
  if (first.ok) return { latitude: first.latitude, longitude: first.longitude };
  if (first.deniedPermission) return null; // retrying won't help

  // Fallback: Wi-Fi/IP-based positioning, longer timeout — much more likely
  // to succeed on devices without a GPS chip, just less precise.
  const second = await getPosition({ timeout: 10000, maximumAge: 60000, enableHighAccuracy: false });
  return second.ok ? { latitude: second.latitude, longitude: second.longitude } : null;
}

// ─── Format helpers ───────────────────────────────────────────────────────────

export function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

export function formatPKR(amount: number): string {
  if (amount >= 1_000_000) return `PKR ${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 100_000) return `PKR ${(amount / 1_000).toFixed(0)}K`;
  return `PKR ${Math.round(amount).toLocaleString()}`;
}

export function verdictColor(verdict: VerdictType): string {
  switch (verdict) {
    case 'genuine': return 'var(--color-primary)';
    case 'suspicious': return 'var(--color-secondary)';
    case 'unverified': return 'var(--color-on-surface-variant)';
  }
}

export function verdictIcon(verdict: VerdictType): string {
  switch (verdict) {
    case 'genuine': return 'verified';
    case 'suspicious': return 'warning';
    case 'unverified': return 'help_outline';
  }
}
