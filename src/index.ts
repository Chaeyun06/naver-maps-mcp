import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// -----------------------------------------------------------------------------
// Configuration Schema (unchanged)
// -----------------------------------------------------------------------------
export const configSchema = z.object({
  NAVER_CLIENT_ID: z.string().describe("네이버 클라우드 플랫폼 Client ID"),
  NAVER_CLIENT_SECRET: z
    .string()
    .describe("네이버 클라우드 플랫폼 Client Secret"),
  debug: z.boolean().default(false).describe("디버그 로깅 활성화"),
});

// -----------------------------------------------------------------------------
// Main Export
// -----------------------------------------------------------------------------
export default function ({
  config,
}: {
  config: z.infer<typeof configSchema>;
}) {
  const server = new McpServer({
    name: "naver-directions",
    version: "1.0.0",
  });

  // ---------------------------------------------------------------------------
  // 네이버 API 공통 호출 함수 (expectBinary 플래그 추가)
  // ---------------------------------------------------------------------------
  async function makeNaverAPIRequest(
    endpoint: string,
    params: Record<string, any>,
    expectBinary = false
  ) {
    const { NAVER_CLIENT_ID, NAVER_CLIENT_SECRET } = config;

    const baseUrl = "https://maps.apigw.ntruss.com";
    const url = new URL(endpoint, baseUrl);

    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.append(key, String(value));
      }
    });

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-NCP-APIGW-API-KEY-ID": NAVER_CLIENT_ID,
        "X-NCP-APIGW-API-KEY": NAVER_CLIENT_SECRET,
      },
    });

    if (!response.ok) {
      throw new Error(
        `네이버 API 오류: ${response.status} ${response.statusText}`
      );
    }

    return expectBinary ? response.arrayBuffer() : response.json();
  }

  // ---------------------------------------------------------------------------
  // Helper: 좌표 형식 확인
  // ---------------------------------------------------------------------------
  function isCoordinate(str: string): boolean {
    const [lng, lat] = str.split(",").map((s) => parseFloat(s.trim()));
    return (
      !isNaN(lng) &&
      !isNaN(lat) &&
      lng >= -180 &&
      lng <= 180 &&
      lat >= -90 &&
      lat <= 90
    );
  }

  // ---------------------------------------------------------------------------
  // 길찾기 도구 (기존 로직 유지)
  // ---------------------------------------------------------------------------
  server.tool(
    "naver_directions",
    "네이버 지도 API를 사용하여 두 지점 간의 길찾기 정보를 제공합니다",
    {
      start: z.string().describe('출발지 (주소 또는 "경도,위도" 형식)'),
      goal: z.string().describe('도착지 (주소 또는 "경도,위도" 형식)'),
      option: z
        .enum(["trafast", "tracomfort", "traoptimal", "trainormal"])
        .default("trafast")
        .describe(
          "경로 옵션: trafast(실시간 빠른길), tracomfort(편안한길), traoptimal(최적경로), trainormal(일반도로)"
        ),
      waypoints: z
        .string()
        .optional()
        .describe('경유지 좌표 (선택사항, "경도1,위도1:경도2,위도2" 형식)'),
    },
    async ({ start, goal, option, waypoints }) => {
      try {
        // 주소를 좌표로 변환 (필요한 경우)
        let startCoords = start;
        let goalCoords = goal;

        if (!isCoordinate(start)) {
          const geo = await makeNaverAPIRequest(
            "/map-geocode/v2/geocode",
            { query: start }
          );
          if (geo.addresses?.length) {
            const { x, y } = geo.addresses[0];
            startCoords = `${x},${y}`;
          }
        }

        if (!isCoordinate(goal)) {
          const geo = await makeNaverAPIRequest(
            "/map-geocode/v2/geocode",
            { query: goal }
          );
          if (geo.addresses?.length) {
            const { x, y } = geo.addresses[0];
            goalCoords = `${x},${y}`;
          }
        }

        const params: Record<string, any> = {
          start: startCoords,
          goal: goalCoords,
          option,
        };
        if (waypoints) params.waypoints = waypoints;

        const data = await makeNaverAPIRequest(
          "/map-direction/v1/driving",
          params
        );

        const route = data.route || {};
        const best =
          route.trafast?.[0] ||
          route.traoptimal?.[0] ||
          route.tracomfort?.[0] ||
          route.trainormal?.[0];

        if (!best) {
          return {
            content: [{ type: "text", text: "경로를 찾을 수 없습니다." }],
          };
        }

        const { summary } = best;
        const result = {
          distance: `${(summary.distance / 1000).toFixed(1)}km`,
          duration: `${Math.round(summary.duration / 60000)}분`,
          tollFare: summary.tollFare
            ? `${summary.tollFare.toLocaleString()}원`
            : "0원",
          fuelPrice: summary.fuelPrice
            ? `${summary.fuelPrice.toLocaleString()}원`
            : "0원",
          start: summary.start.location,
          goal: summary.goal.location,
        };

        return {
          content: [
            {
              type: "text",
              text: `🚗 길찾기 결과\n\n📍 출발: ${result.start}\n📍 도착: ${result.goal}\n\n📏 거리: ${result.distance}\n⏱️ 소요시간: ${result.duration}\n💰 통행료: ${result.tollFare}\n⛽ 예상 연료비: ${result.fuelPrice}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `오류 발생: ${err.message}` }],
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 지오코딩 & 역지오코딩 도구 (원본 유지)
  // ---------------------------------------------------------------------------
  server.tool(
    "naver_geocode",
    "주소를 위도/경도 좌표로 변환합니다",
    { address: z.string().describe("변환할 주소") },
    async ({ address }) => {
      try {
        const data = await makeNaverAPIRequest(
          "/map-geocode/v2/geocode",
          { query: address }
        );

        if (!data.addresses?.length) {
          return {
            content: [{ type: "text", text: "주소를 찾을 수 없습니다." }],
          };
        }

        const { y, x, roadAddress, jibunAddress } = data.addresses[0];
        return {
          content: [
            {
              type: "text",
              text: `📍 주소: ${roadAddress || jibunAddress}\n🌐 좌표: ${y}, ${x} (위도, 경도)`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `오류 발생: ${err.message}` }],
        };
      }
    }
  );

  server.tool(
    "naver_reverse_geocode",
    "위도/경도 좌표를 주소로 변환합니다",
    {
      lat: z.number().describe("위도"),
      lng: z.number().describe("경도"),
    },
    async ({ lat, lng }) => {
      try {
        const data = await makeNaverAPIRequest(
          "/map-reversegeocode/v2/gc",
          { coords: `${lng},${lat}`, output: "json" }
        );

        if (!data.results?.length) {
          return {
            content: [{ type: "text", text: "해당 좌표의 주소를 찾을 수 없습니다." }],
          };
        }

        const { text } = data.results[0];
        return {
          content: [
            {
              type: "text",
              text: `🌐 좌표: ${lat}, ${lng}\n📍 주소: ${text}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `오류 발생: ${err.message}` }],
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // 정적 지도 생성 도구: 이미지(Base64) 반환으로 변경
  // ---------------------------------------------------------------------------
  server.tool(
    "naver_static_map",
    "네이버 지도 API를 사용하여 정적 지도 이미지를 Base64 data URI로 반환합니다",
    {
      center: z.string().describe("지도 중심 좌표 (경도,위도 형식) 또는 주소"),
      level: z.number().min(1).max(20).default(6).describe("지도 확대 레벨 (1-20)"),
      w: z.number().min(1).max(1280).default(400).describe("지도 이미지 너비(px)"),
      h: z.number().min(1).max(1280).default(400).describe("지도 이미지 높이(px)"),
      format: z.enum(["png", "jpeg"]).default("png").describe("이미지 포맷"),
    },
    async ({ center, level, w, h, format }) => {
      try {
        let centerCoords = center;

        if (!isCoordinate(center)) {
          const geo = await makeNaverAPIRequest(
            "/map-geocode/v2/geocode",
            { query: center }
          );
          if (!geo.addresses?.length) {
            throw new Error("지오코딩 결과가 없습니다.");
          }
          const { x, y } = geo.addresses[0];
          centerCoords = `${x},${y}`;
        }

        // 정적 지도 호출 → 바이너리
        const buffer = (await makeNaverAPIRequest(
          "/map-static/v2/raster",
          { center: centerCoords, level, w, h, format },
          true
        )) as ArrayBuffer;

        // Base64 인코딩 & Data URI
        const base64 = Buffer.from(buffer).toString("base64");
        const dataUri = `data:image/${format};base64,${base64}`;

        return {
          content: [
            {
              type: "image",
              image_url: dataUri,
            },
            {
              type: "text",
              text: `🗺️ 정적 지도 (center: ${centerCoords}, level: ${level}, size: ${w}x${h})`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `오류 발생: ${err.message}` }],
        };
      }
    }
  );

  return server.server;
}
