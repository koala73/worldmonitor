targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the azd environment — used to derive resource names and tags.')
param environmentName string

@minLength(1)
@description('Primary Azure region for all resources.')
param location string

@description('Azure OpenAI (or any OpenAI-compatible) chat completions URL used by the analysis panels. Leave blank to disable LLM analysis. For Azure OpenAI use: https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=2024-10-21')
param llmApiUrl string = ''

@secure()
@description('API key for the LLM endpoint above. For Azure OpenAI this is the resource key; sent via the api-key header automatically when the host is *.openai.azure.com.')
param llmApiKey string = ''

@description('Model / deployment name for the LLM endpoint. For Azure OpenAI use the deployment name.')
param llmModel string = ''

@description('Azure OpenAI Entra ID tenant id. Set this together with the client id/secret to use Entra ID (service principal) auth instead of an API key — required when key-based auth is disabled on the Azure OpenAI resource.')
param azureOpenAiTenantId string = ''

@description('Azure OpenAI Entra ID (service principal / app registration) client id.')
param azureOpenAiClientId string = ''

@secure()
@description('Azure OpenAI Entra ID (service principal / app registration) client secret.')
param azureOpenAiClientSecret string = ''

var resourceSuffix = take(uniqueString(subscription().id, environmentName, location), 6)
var tags = { 'azd-env-name': environmentName }

// Container App names (also used for in-environment service discovery).
var webAppName = 'ca-wm-${resourceSuffix}'
var redisRestAppName = 'ca-redisrest-${resourceSuffix}'

// Stable, source-free shared token for the internal redis-rest shim (defense in depth;
// the shim is internal-ingress only). Deterministic so re-deploys don't churn it.
var redisRestToken = guid(subscription().id, environmentName, 'redis-rest-token')

resource rg 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module monitoring './modules/monitoring.bicep' = {
  name: 'monitoring'
  scope: rg
  params: {
    name: 'wm-${resourceSuffix}'
    location: location
    tags: tags
  }
}

module registry './modules/registry.bicep' = {
  name: 'registry'
  scope: rg
  params: {
    name: replace('crwm${resourceSuffix}', '-', '')
    location: location
    tags: tags
  }
}

module redis './modules/redis.bicep' = {
  name: 'redis'
  scope: rg
  params: {
    name: 'redis-wm-${resourceSuffix}'
    location: location
    tags: tags
  }
}

module containerEnv './modules/container-env.bicep' = {
  name: 'container-env'
  scope: rg
  params: {
    name: 'cae-wm-${resourceSuffix}'
    location: location
    tags: tags
    logAnalyticsWorkspaceName: monitoring.outputs.logAnalyticsWorkspaceName
  }
}

// Phase 1: redis-rest shim (internal ingress). Builds the SRH connection string from
// the Azure Cache for Redis access key inside the module (no secrets in outputs).
module redisRestApp './modules/container-app-redis-rest.bicep' = {
  name: 'redis-rest-app'
  scope: rg
  params: {
    name: redisRestAppName
    location: location
    tags: tags
    containerAppsEnvironmentId: containerEnv.outputs.id
    redisCacheName: redis.outputs.name
    redisRestToken: redisRestToken
  }
}

// Phase 1: web app (external ingress). Talks to the shim over internal DNS.
module webApp './modules/container-app-web.bicep' = {
  name: 'web-app'
  scope: rg
  params: {
    name: webAppName
    location: location
    tags: tags
    containerAppsEnvironmentId: containerEnv.outputs.id
    redisRestUrl: 'http://${redisRestAppName}'
    redisRestToken: redisRestToken
    llmApiUrl: llmApiUrl
    llmApiKey: llmApiKey
    llmModel: llmModel
    azureOpenAiTenantId: azureOpenAiTenantId
    azureOpenAiClientId: azureOpenAiClientId
    azureOpenAiClientSecret: azureOpenAiClientSecret
  }
}

// Phase 2: AcrPull role assignments (separate modules → no circular dependency).
module acrPullWeb './modules/acr-pull-role.bicep' = {
  name: 'acr-pull-web'
  scope: rg
  params: {
    acrName: registry.outputs.name
    principalId: webApp.outputs.principalId
  }
}

module acrPullRedisRest './modules/acr-pull-role.bicep' = {
  name: 'acr-pull-redis-rest'
  scope: rg
  params: {
    acrName: registry.outputs.name
    principalId: redisRestApp.outputs.principalId
  }
}

output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = registry.outputs.loginServer
output AZURE_LOG_ANALYTICS_WORKSPACE_NAME string = monitoring.outputs.logAnalyticsWorkspaceName
output WEB_URL string = webApp.outputs.uri
