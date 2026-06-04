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

// Placeholder image allows provisioning before the app image exists in ACR.
// azd deploy configures the registry/identity link and pushes the real image.
param containerImageName string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

var hasLlmKey = !empty(llmApiKey)

var baseSecrets = [
  {
    name: 'redis-rest-token'
    value: redisRestToken
  }
]
var llmSecrets = hasLlmKey ? [
  {
    name: 'llm-api-key'
    value: llmApiKey
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
      secrets: concat(baseSecrets, llmSecrets)
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
          env: concat(baseEnv, llmKeyEnv)
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
