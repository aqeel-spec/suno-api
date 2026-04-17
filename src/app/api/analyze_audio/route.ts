import { NextResponse, NextRequest } from 'next/server';
import { corsHeaders } from '@/lib/utils';
import { analyzeBuffer, analyzeUrl } from '@/lib/audioAnalyzer';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

export async function POST(req: NextRequest) {
  if (req.method !== 'POST') {
    return new NextResponse('Method Not Allowed', {
      headers: { Allow: 'POST', ...corsHeaders },
      status: 405,
    });
  }

  try {
    const contentType = req.headers.get('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      // File upload path
      const form = await req.formData();
      const file = form.get('file') as File | null;

      if (!file) {
        return new NextResponse(
          JSON.stringify({ error: 'Missing form field: file' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
      if (file.size > MAX_FILE_BYTES) {
        return new NextResponse(
          JSON.stringify({ error: `File too large. Maximum allowed size is 50 MB.` }),
          { status: 413, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const analysis = await analyzeBuffer(buffer, file.type || undefined);

      return new NextResponse(JSON.stringify(analysis), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });

    } else {
      // JSON + URL path
      const body = await req.json();
      const { url } = body;

      if (!url || typeof url !== 'string') {
        return new NextResponse(
          JSON.stringify({ error: 'Provide either multipart/form-data with a "file" field, or JSON with a "url" field.' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      const analysis = await analyzeUrl(url);

      return new NextResponse(JSON.stringify(analysis), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  } catch (error: any) {
    console.error('Error analyzing audio:', error);
    return new NextResponse(
      JSON.stringify({ error: error.message || error.toString() }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
