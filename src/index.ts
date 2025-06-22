// src/index.tsMore actions
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Configuration Schema 정의 (공식 문서 권장 사항)
export const configSchema = z.object({
  NAVER_CLIENT_ID: z.string().describe("네이버 클라우드 플랫폼 Client ID"),
  NAVER_CLIENT_SECRET: z
    .string()
    .describe("네이버 클라우드 플랫폼 Client Secret"),
  debug: z.boolean().default(false).describe("디버그 로깅 활성화"),
});

export default function ({ config }: { config: z.infer<typeof configSchema> }) {
  const server = new McpServer({
    name: "naver-directions",
    version: "1.0.0",
  });

  // 네이버 API 공통 호출 함수
  async function makeNaverAPIRequest(
    endpoint: string,
    params: Record<string, any>
  ) {
    const { NAVER_CLIENT_ID, NAVER_CLIENT_SECRET } = config;

    const baseUrl = "https://maps.apigw.ntruss.com";
    const url = new URL(endpoint, baseUrl);

    Object.keys(params).forEach((key) => {
      if (params[key] !== undefined) {
        url.searchParams.append(key, params[key]);
      }
    });

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-ncp-apigw-api-key-id": NAVER_CLIENT_ID,
        "x-ncp-apigw-api-key": NAVER_CLIENT_SECRET,
      },
    });

    if (!response.ok) {
      throw new Error(
        `네이버 API 오류: ${response.status} ${response.statusText} ${window.location.hostname}`
      );
    }

    return await response.json();
  }

  // 길찾기 도구
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

        // 좌표 형식이 아닌 경우 지오코딩 수행
        if (!isCoordinate(start)) {
          const geocodeResult = await makeNaverAPIRequest(
            "/map-geocode/v2/geocode",
            { query: start }
          );
          if (geocodeResult.addresses && geocodeResult.addresses.length > 0) {
            const addr = geocodeResult.addresses[0];
            startCoords = `${addr.x},${addr.y}`;
          }
        }

        if (!isCoordinate(goal)) {
          const geocodeResult = await makeNaverAPIRequest(
            "/map-geocode/v2/geocode",
            { query: goal }
          );
          if (geocodeResult.addresses && geocodeResult.addresses.length > 0) {
            const addr = geocodeResult.addresses[0];
            goalCoords = `${addr.x},${addr.y}`;
          }
        }

        const params: any = { start: startCoords, goal: goalCoords, option };
        if (waypoints) params.waypoints = waypoints;

        const data = await makeNaverAPIRequest(
          "/map-direction/v1/driving",
          params
        );

        // 결과 처리
        const route = data.route || {};
        const bestRoute =
          route.trafast?.[0] ||
          route.traoptimal?.[0] ||
          route.tracomfort?.[0] ||
          route.trainormal?.[0];

        if (!bestRoute) {
          return {
            content: [
              {
                type: "text",
                text: "경로를 찾을 수 없습니다.",
              },
            ],
          };
        }

        const summary = bestRoute.summary;
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
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `오류 발생: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // 지오코딩 도구
  server.tool(
    "naver_geocode",
    "주소를 위도/경도 좌표로 변환합니다",
    {
      address: z.string().describe("변환할 주소"),
    },
    async ({ address }) => {
      try {
        const data = await makeNaverAPIRequest("/map-geocode/v2/geocode", {
          query: address,
        });

        if (!data.addresses || data.addresses.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "주소를 찾을 수 없습니다.",
              },
            ],
          };
        }

        const addr = data.addresses[0];
        return {
          content: [
            {
              type: "text",
              text: `📍 주소: ${
                addr.roadAddress || addr.jibunAddress
              }\n🌐 좌표: ${addr.y}, ${addr.x} (위도, 경도)`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `오류 발생: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // 역지오코딩 도구
  server.tool(
    "naver_reverse_geocode",
    "위도/경도 좌표를 주소로 변환합니다",
    {
      lat: z.number().describe("위도"),
      lng: z.number().describe("경도"),
    },
    async ({ lat, lng }) => {
      try {
        const data = await makeNaverAPIRequest("/map-reversegeocode/v2/gc", {
          coords: `${lng},${lat}`,
          output: "json",
        });

        if (!data.results || data.results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "해당 좌표의 주소를 찾을 수 없습니다.",
              },
            ],
          };
        }

        const result = data.results[0];
        return {
          content: [
            {
              type: "text",
              text: `🌐 좌표: ${lat}, ${lng}\n📍 주소: ${result.text}`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `오류 발생: ${error.message}`,
            },
          ],
        };
      }
    }
  );


  // 헬퍼 함수: 좌표 형식 확인
  function isCoordinate(str: string): boolean {
    const parts = str.split(",");
    return (
      parts.length === 2 &&
      !isNaN(parseFloat(parts[0])) &&
      !isNaN(parseFloat(parts[1]))
    );
  }
More actions
  return server.server;
}
