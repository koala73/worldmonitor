targetScope = 'resourceGroup'

@description('Azure Cache for Redis resource name.')
param name string
param location string = resourceGroup().location
param tags object = {}

resource redisCache 'Microsoft.Cache/redis@2024-03-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'Basic'
      family: 'C'
      capacity: 0
    }
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
    redisConfiguration: {
      'maxmemory-policy': 'allkeys-lru'
    }
  }
}

output name string = redisCache.name
output hostName string = redisCache.properties.hostName
output sslPort int = redisCache.properties.sslPort
