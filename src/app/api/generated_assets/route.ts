import { NextResponse, NextRequest } from "next/server";
import { getGeneratedAssets, getGeneratedAssetById } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    const source = url.searchParams.get('source');
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);

    if (id) {
      const asset = getGeneratedAssetById(id);
      if (!asset) {
        return new NextResponse(JSON.stringify({ error: 'Asset not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      return new NextResponse(JSON.stringify(asset), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    let assets = getGeneratedAssets();
    if (source) {
      assets = assets.filter(a => a.source === source);
    }

    return new NextResponse(JSON.stringify({
      total: assets.length,
      assets: assets.slice(0, limit),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error) {
    console.error('Error fetching generated assets:', error);
    return new NextResponse(JSON.stringify({ error: 'Internal server error. ' + error }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}
