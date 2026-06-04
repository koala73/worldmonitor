targetScope = 'resourceGroup'

@description('Container App name for the web app (SPA + API sidecar).')
param name string
param location string = resourceGroup().location
param tags object = {}

@description('Resource ID of the Container Apps managed environment.')
param containerAppsEnvironmentId string

@description('Internal URL of the redis-rest shim (e.g. http://ca-redisrest-xxxxxx).')
param redisRestUrl string

@secure()
@description('Shared bearer token the app presents to the REST shim.')
param redisRestToken string

@description('LLM chat completions URL (blank disables analysis).')
param llmApiUrl string = ''

@secure()
@description('LLM API key (blank disables analysis).')
param llmApiKey string = ''

@description('LLM model / Azure OpenAI deployment name.')
param llmModel string = ''

@description('Azure OpenAI Entra ID tenant id (blank uses key-based auth).')
param azureOpenAiTenantId string = ''

@description('Azure OpenAI Entra ID (service principal) client id.')
param azureOpenAiClientId string = ''

@secure()
@description('Azure OpenAI Entra ID (service principal) client secret.')
param azureOpenAiClientSecret string = ''

// Signing secret for anonymous browser session tokens (/api/wm-session). The
// frontend mints an HMAC-signed session token to call tier-gated RPCs (e.g.
// news analysis). Without this the session endpoint fails closed with 503.
@secure()
param wmSessionSecret string = newGuid()

// Placeholder image allows provisioning before the app image exists in ACR.
// azd deploy configures the registry/identity link and pushes the real image.
param containerImageName string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

var hasLlmKey = !empty(llmApiKey)
// Entra ID auth is enabled only when tenant, client id, AND secret are all set.
var hasEntraAuth = !empty(azureOpenAiTenantId) && !empty(azureOpenAiClientId) && !empty(azureOpenAiClientSecret)

var baseSecrets = [
  {
    name: 'redis-rest-token'
    value: redisRestToken
  }
  {
    name: 'wm-session-secret'
    value: wmSessionSecret
  }
]
var llmSecrets = hasLlmKey ? [
  {
    name: 'llm-api-key'
    value: llmApiKey
  }
] : []
var entraSecrets = hasEntraAuth ? [
  {
    name: 'azure-openai-client-secret'
    value: azureOpenAiClientSecret
  }
] : []

var baseEnv = [
  {
    name: 'LOCAL_API_MODE'
    value: 'docker'
  }
  {
    name: 'LOCAL_API_CLOUD_FALLBACK'
    value: 'false'
  }
  {
    name: 'UPSTASH_REDIS_REST_URL'
    value: redisRestUrl
  }
  {
    name: 'UPSTASH_REDIS_REST_TOKEN'
    secretRef: 'redis-rest-token'
  }
  {
    name: 'WM_SESSION_SECRET'
    secretRef: 'wm-session-secret'
  }
  {
    name: 'LLM_API_URL'
    value: llmApiUrl
  }
  {
    name: 'LLM_MODEL'
    value: llmModel
  }
]
var llmKeyEnv = hasLlmKey ? [
  {
    name: 'LLM_API_KEY'
    secretRef: 'llm-api-key'
  }
] : []
var entraEnv = hasEntraAuth ? [
  {
    name: 'AZURE_OPENAI_TENANT_ID'
    value: azureOpenAiTenantId
  }
  {
    name: 'AZURE_OPENAI_CLIENT_ID'
    value: azureOpenAiClientId
  }
  {
    name: 'AZURE_OPENAI_CLIENT_SECRET'
    secretRef: 'azure-openai-client-secret'
  }
] : []

resource webApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  tags: union(tags, { 'azd-service-name': 'app' })
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    environmentId: containerAppsEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
      }
      secrets: concat(baseSecrets, llmSecrets, entraSecrets)
    }
    template: {
      containers: [
        {
          name: 'app'
          image: containerImageName
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: concat(baseEnv, llmKeyEnv, entraEnv)
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 2
      }
    }
  }
}

output principalId string = webApp.identity.principalId
output name string = webApp.name
output uri string = 'https://${webApp.properties.configuration.ingress.fqdn}'
