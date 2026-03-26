import moment from 'moment';

export const calculateActivationDate = (baseDate, frequency, xValue) => {
  const date = moment(baseDate);
  
  // Frequency check
  if (frequency === 'T+X in days') {
    return date.add(xValue, 'days').toDate();
  } 
  else if (frequency === 'T-X in hours') {
    return date.subtract(xValue, 'hours').toDate();
  }
  
  return date.toDate();
};