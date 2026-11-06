import { proxyMedia } from "../../lib/edgeProxy";

export const config = { runtime: "edge" };

export default function handler(request: Request): Promise<Response> {
  return proxyMedia(request, true);
}
