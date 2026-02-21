# OnlyOffice Document Server Setup

OnlyOffice Document Server provides full Word document editing capabilities for the Ninja Platform editorial services module.

## Features

- Full DOCX compatibility with round-trip fidelity
- Track changes and comments
- Real-time collaborative editing
- Document conversion (DOCX, PDF, ODT, etc.)

## Quick Start (Development)

1. **Start OnlyOffice:**
   ```bash
   cd ninja-backend/docker/onlyoffice
   docker-compose up -d
   ```

2. **Verify it's running:**
   ```bash
   curl http://localhost:8080/healthcheck
   # Should return: true
   ```

3. **Configure Backend:**
   Add to your `.env`:
   ```env
   ONLYOFFICE_URL=http://localhost:8080
   ONLYOFFICE_JWT_SECRET=your-dev-secret-change-in-production
   API_URL=http://localhost:3001
   ```

4. **Restart backend:**
   ```bash
   npm run dev
   ```

## Production Deployment (AWS)

### Option 1: ECS Fargate

1. Create ECR repository or use DockerHub image
2. Create ECS Task Definition with:
   - Image: `onlyoffice/documentserver:8.0`
   - CPU: 2048, Memory: 4096
   - Port mapping: 80
   - Environment variables from Secrets Manager

3. Create ECS Service:
   - Launch type: Fargate
   - Target group for ALB
   - Health check: `/healthcheck`

4. Configure ALB:
   - Target group pointing to ECS service
   - HTTPS listener with SSL certificate
   - Health check path: `/healthcheck`

### Option 2: EC2 with Docker Compose

1. Launch EC2 instance (t3.medium minimum)
2. Install Docker and Docker Compose
3. Copy `docker-compose.prod.yml` and `.env.prod`
4. Run: `docker-compose -f docker-compose.prod.yml up -d`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ONLYOFFICE_JWT_SECRET` | Yes | JWT secret for document server (32+ chars) |
| `ONLYOFFICE_SECURE_LINK_SECRET` | Yes | Secure link secret |
| `ONLYOFFICE_URL` | Yes | URL where OnlyOffice is accessible |
| `ONLYOFFICE_CALLBACK_URL` | No | Override callback URL (default: `API_URL/api/v1/editor/callback`) |
| `ONLYOFFICE_DOCUMENT_URL` | No | Override document URL (default: `API_URL/api/v1/editor/document`) |

## Security Considerations

1. **JWT Secret**: Use a strong, random secret (32+ characters)
2. **HTTPS**: Always use HTTPS in production (SSL at load balancer)
3. **Network**: Keep OnlyOffice in private subnet, accessed via ALB
4. **Updates**: Keep OnlyOffice updated for security patches

## Troubleshooting

### OnlyOffice not starting
- Check Docker logs: `docker logs ninja-onlyoffice`
- Ensure port 8080 is available
- Verify minimum 4GB RAM allocated to Docker

### Document won't open
- Check JWT secret matches in backend and OnlyOffice
- Verify callback URL is accessible from OnlyOffice container
- Check browser console for CORS errors

### Changes not saving
- Verify callback endpoint is reachable
- Check backend logs for callback errors
- Ensure storage permissions are correct

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/editor/status` | GET | Check OnlyOffice availability |
| `/api/v1/editor/session` | POST | Create editing session |
| `/api/v1/editor/session/:id` | GET | Get session info |
| `/api/v1/editor/session/:id` | DELETE | Close session |
| `/api/v1/editor/callback` | POST | OnlyOffice callback (internal) |
| `/api/v1/editor/document/:sessionId` | GET | Serve document (internal) |

## License

OnlyOffice Community Edition is free for up to 20 concurrent connections.
For more connections, see [OnlyOffice pricing](https://www.onlyoffice.com/docs-enterprise-prices.aspx).
