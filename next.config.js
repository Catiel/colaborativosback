/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Configurar Next.js para permitir WebSockets, manteniendo las conexiones abiertas
  poweredByHeader: false,
  api: {
    bodyParser: false,
    externalResolver: true,
  },
  // Configuración adicional para Digital Ocean App Platform
  env: {
    PORT: process.env.PORT || '3000',
  },
  // Asegurarse de que Next.js no comprima las respuestas WebSocket
  compress: false,
};

module.exports = nextConfig; 