// 流量统计注入（由 liuliang-monitor 自动添加）：在 HTML 响应的 </head> 前注入统计脚本 t.js。
// 适用于 SSR/静态所有页面；非 HTML 响应原样放行；页面已含 t.js 时不重复注入。
// 隐私说明：t.js 无 Cookie、不采集个人身份信息，详见中枢站点说明。
export default async (request, context) => {
  const response = await context.next();
  const ct = response.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return response;

  let html;
  try {
    html = await response.text();
  } catch {
    return response;
  }
  if (html.includes("/t.js")) {
    return new Response(html, response);
  }

  const tag = '<script defer src="https://liuliang-monitor-hub.netlify.app/t.js"></script>';
  let out;
  if (/<\/head>/i.test(html)) {
    out = html.replace(/<\/head>/i, tag + "</head>");
  } else if (/<\/body>/i.test(html)) {
    out = html.replace(/<\/body>/i, tag + "</body>");
  } else {
    return new Response(html, response);
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(out, { status: response.status, headers });
};

export const config = { path: "/*" };
