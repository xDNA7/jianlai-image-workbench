import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
  index('routes/home.tsx'),
  route('design', 'routes/design.tsx'),
  route('manage/:adminPath', 'routes/manage.$adminPath.tsx'),
] satisfies RouteConfig
