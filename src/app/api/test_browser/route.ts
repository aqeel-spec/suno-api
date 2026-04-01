import { NextResponse, NextRequest } from "next/server";
import { cookies } from 'next/headers';
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    // We force the captcha process to run, which will forcefully launch the 
    // browser invisibly or visibly based on BROWSER_HEADLESS in .env.
    // It will stay open if BROWSER_KEEP_OPEN=true
    const cookieHeader = (await cookies()).toString();
    const api = await sunoApi(cookieHeader);
    
    console.log("Forcing browser to launch for testing...");
    const token = await api.getCaptcha(true); // true = force

    return new NextResponse(JSON.stringify({ 
      success: true, 
      message: 'Browser opened successfully for testing!',
      captcha_token_retrieved: token ? true : false
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  } catch (error: any) {
    console.error('Error opening browser:', error?.message || error);
    return new NextResponse(JSON.stringify({ error: 'Failed to open browser: ' + (error?.message || String(error)) }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}
