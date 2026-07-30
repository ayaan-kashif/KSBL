import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "Supabase configuration missing" }, { status: 500 });
  }

  try {
    // 1. Fetch all products
    const prodRes = await fetch(`${supabaseUrl}/rest/v1/Product?select=*,scans:Scan(id,verdict)&order=created_at.desc`, {
      headers: { "apikey": anonKey, "Authorization": `Bearer ${anonKey}` }
    });

    if (!prodRes.ok) {
      return NextResponse.json({ error: "Failed to fetch products" }, { status: 500 });
    }

    const products = await prodRes.json();

    // Map database fields to the frontend inventory model structure
    const mapped = products.map((p: any) => {
      const scansList = p.scans ?? [];
      const totalScans = scansList.length;

      // Status determines the verdict tag dynamically
      let displayVerdict = "genuine";
      if (p.status === "flagged") {
        displayVerdict = "suspicious";
      } else if (p.status === "recalled") {
        displayVerdict = "counterfeit";
      } else if (totalScans === 0) {
        displayVerdict = "unverified";
      }

      // Dynamic color/accent matching the verdict.
      // These mirror the --verdict-* tokens in globals.css but are emitted as
      // literal hex, not var() references: the inventory card appends a hex
      // alpha suffix to `accent` (`accent + '40'`), which only works on a
      // literal colour — a var() call would produce invalid CSS.
      let color = "#ecfdf5";   // --verdict-genuine-bg
      let accent = "#047857";  // --verdict-genuine
      if (displayVerdict === "suspicious") {
        color = "#fffbeb";     // --verdict-suspicious-bg
        accent = "#b45309";    // --verdict-suspicious
      } else if (displayVerdict === "counterfeit") {
        color = "#fff1f2";     // --verdict-counterfeit-bg
        accent = "#be123c";    // --verdict-counterfeit
      } else if (displayVerdict === "unverified") {
        color = "#f1f5f9";     // neutral slate surface
        accent = "#5f6b7d";    // --text-muted
      }

      return {
        id: p.id,
        name: p.product_name,
        brand: p.brand_name,
        barcode: p.sku,
        stock: totalScans, // Stock is count of scans representing market retail presence!
        verdict: displayVerdict,
        status: p.status, // "active", "flagged", "recalled"
        color,
        accent,
        reference_batch_pattern: p.reference_batch_pattern,
        reference_image_url: p.reference_image_url
      };
    });

    return NextResponse.json(mapped);
  } catch (err) {
    console.error("Products GET error:", err);
    return NextResponse.json({ error: "Failed to load inventory products" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "Supabase configuration missing" }, { status: 500 });
  }

  try {
    const body = await req.json();
    const { name, brand, barcode, reference_image } = body;

    if (!name || !brand || !barcode) {
      return NextResponse.json({ error: "Product Name, Brand, and Barcode (SKU) are required fields." }, { status: 400 });
    }

    // 1. Create reference product in Supabase database
    const createRes = await fetch(`${supabaseUrl}/rest/v1/Product`, {
      method: "POST",
      headers: {
        "apikey": anonKey,
        "Authorization": `Bearer ${anonKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify({
        sku: barcode,
        brand_name: brand,
        product_name: name,
        reference_batch_pattern: "^XP-[0-9]{3}-KHI", // Standard Karachi batch check pattern fallback
        reference_image_url: reference_image || null,
        avg_unit_price_pkr: 250, // Standard unit price fallback
        status: "active"
      })
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      // Handle barcode unique constraint violation
      if (createRes.status === 409 || errText.includes("duplicate key")) {
        return NextResponse.json({ error: "A product with this barcode already exists in the system." }, { status: 409 });
      }
      return NextResponse.json({ error: `Database insertion error: ${errText}` }, { status: 500 });
    }

    const created = await createRes.json();
    return NextResponse.json({ success: true, product: created[0] });
  } catch (err) {
    console.error("Product POST error:", err);
    return NextResponse.json({ error: "Failed to register new reference product." }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "Supabase configuration missing" }, { status: 500 });
  }

  try {
    const body = await req.json();
    const { id, status } = body;

    if (!id || !status) {
      return NextResponse.json({ error: "Missing required fields: id, status" }, { status: 400 });
    }

    const patchRes = await fetch(`${supabaseUrl}/rest/v1/Product?id=eq.${id}`, {
      method: "PATCH",
      headers: {
        "apikey": anonKey,
        "Authorization": `Bearer ${anonKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ status })
    });

    if (!patchRes.ok) {
      return NextResponse.json({ error: "Failed to update product status" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Product PATCH error:", err);
    return NextResponse.json({ error: "Failed to update product status" }, { status: 500 });
  }
}
