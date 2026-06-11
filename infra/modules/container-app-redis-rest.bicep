targetScope = 'resourceGroup'

@description('Container App name for the redis-rest shim (also its internal DNS name).')
param name string
param location string = resourceGroup().location
param tags object = {}

@description('Resource ID of the Container Apps managed environment.')
param containerAppsEnvironmentId string

@description('Name of the Azure Cache for Redis (same resource group) to build the connection string from.')
param redisCacheName string

@secure()
@description('Shared bearer token clients must present to the REST shim.')
param redisRestToken string

// Placeholder image allows provisioning before the app image exists in ACR.
// azd deploy configures the registry/identity link and pushes the real image.
param containerImageName string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

resource redisCache 'Microsoft.Cache/redis@2024-03-01' existing = {
  name: redisCacheName
}

var redisConnectionString = 'rediss://:${uriComponent(redisCache.listKeys().primaryKey)}@${redisCache.properties.hostName}:${redisCache.properties.sslPort}'

resource redisRestApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  tags: union(tags, { 'azd-service-name': 'redis-rest' })
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    environmentId: containerAppsEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: 80
        transport: 'auto'
        allowInsecure: true
      }
      secrets: [
        {
          name: 'srh-token'
          value: redisRestToken
        }
        {
          name: 'srh-connection-string'
          value: redisConnectionString
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'redis-rest'
          image: containerImageName
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'PORT'
              value: '80'
            }
            {
              name: 'SRH_TOKEN'
              secretRef: 'srh-token'
            }
            {
              name: 'SRH_CONNECTION_STRING'
              secretRef: 'srh-connection-string'
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output principalId string = redisRestApp.identity.principalId
output name string = redisRestApp.name
