# The identity provider's operator tools (owner enrolment, licence tools). They are TypeScript run with tsx and are not part of the
# production image, so this image carries the whole backend source with its development dependencies.
# Build context: the sso-saas repository root.
FROM node:22-alpine
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json backend/tsconfig.json ./
RUN npm ci
COPY backend/ ./
ENV NODE_ENV=production
