# syntax=docker/dockerfile:1.7
# device-sim 이미지(보강 9, decisions/0086). 시연 compose 안에서만 듣는다(바깥 포트 없음, decisions/0087). 컨텍스트는 저장소 루트
# 프록시 뒤에서 빌드할 때만: --build-arg HTTPS_PROXY=… 와 --secret id=ca,src=<CA 파일>

FROM node:24-alpine AS build
WORKDIR /repo/apps/device-sim
COPY apps/device-sim/package.json apps/device-sim/package-lock.json ./
RUN --mount=type=secret,id=ca,required=false --mount=type=cache,target=/root/.npm \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --no-audit --no-fund
COPY apps/device-sim ./
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-alpine
WORKDIR /app
COPY --from=build /repo/apps/device-sim/package.json ./package.json
COPY --from=build /repo/apps/device-sim/node_modules ./node_modules
COPY --from=build /repo/apps/device-sim/dist ./dist
USER node
CMD ["node", "dist/main.js"]
